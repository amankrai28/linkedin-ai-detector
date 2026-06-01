#!/usr/bin/env node
/**
 * LinkedIn AI Detector — headless harness runner (Phase 0 of the measurement system)
 *
 * Drives the offline harnesses (test/harness*.html) in a REAL headless Chrome and
 * reads back their machine-readable verdict, so the whole measure→fix→re-measure
 * loop runs with no human in the loop and no extra npm deps.
 *
 *   Why a real browser (not jsdom): detection + the jank we measure depend on
 *   innerText / textContent / getComputedStyle / -webkit-line-clamp / layout,
 *   all of which jsdom stubs out — see test/harness.html's header.
 *
 *   Why no puppeteer: node v25 ships a global WebSocket + fetch, which is all the
 *   Chrome DevTools Protocol needs. We talk to the BROWSER-level endpoint
 *   (/json/version → Target.createTarget → Target.attachToTarget {flatten:true})
 *   so there's exactly one websocket and no per-tab /json/new PUT dance.
 *
 * Usage:
 *   node test/run-headless.mjs <path-under-repo-root> [options]
 *
 *   --ready  <js>   expression polled until truthy before reading the result
 *                   (default: the regression harness's data-laid-test beacon)
 *   --result <js>   expression evaluated once ready; its JSON value is printed
 *   --pass   <js>   expression returning the boolean used for the exit code
 *                   (default: result.pass). exit 0 = pass, 2 = fail, 1 = error.
 *   --timeout <ms>  max wait for --ready (default 30000)
 *   --port   <n>    http + base for CDP port (default 8754 / 9222)
 *   --keep-open     don't close the tab / kill Chrome (debugging)
 *   --logs          stream the page console to stderr
 *
 * Example (regression gate):
 *   node test/run-headless.mjs 'test/harness.html?fixture=feed-synthetic.html'
 */

import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const REPO_ROOT = new URL('..', import.meta.url).pathname;
const CHROME =
  process.env.CHROME_BIN ||
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

// ── arg parsing ──────────────────────────────────────────────────────────
const argv = process.argv.slice(2);
const positional = [];
const opts = {};
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === '--keep-open') opts.keepOpen = true;
  else if (a === '--logs') opts.logs = true;
  else if (a.startsWith('--')) opts[a.slice(2)] = argv[++i];
  else positional.push(a);
}
const urlPath = positional[0];
if (!urlPath) {
  console.error('usage: node test/run-headless.mjs <path-under-repo-root> [--ready js] [--result js] [--pass js] [--timeout ms] [--port n]');
  process.exit(1);
}
const HTTP_PORT = Number(opts.port || 8754);
const CDP_PORT = HTTP_PORT + 468; // 8754 → 9222 by default
const TIMEOUT = Number(opts.timeout || 30000);
const READY = opts.ready ||
  "(!!document.documentElement.getAttribute('data-laid-test') || !!window.__laidTestResult)";
const RESULT = opts.result ||
  "(window.__laidTestResult || JSON.parse(document.documentElement.getAttribute('data-laid-test')||'null'))";
const PASS = opts.pass || 'r && r.pass === true';

const TARGET_URL = `http://127.0.0.1:${HTTP_PORT}/${urlPath.replace(/^\//, '')}`;

// ── tiny CDP client over the browser websocket ─────────────────────────────
class CDP {
  constructor(ws) {
    this.ws = ws;
    this.id = 0;
    this.pending = new Map();
    this.listeners = [];
    ws.addEventListener('message', (ev) => {
      const m = JSON.parse(ev.data);
      if (m.id != null && this.pending.has(m.id)) {
        const { resolve, reject } = this.pending.get(m.id);
        this.pending.delete(m.id);
        if (m.error) reject(new Error(m.error.message || JSON.stringify(m.error)));
        else resolve(m.result);
      } else if (m.method) {
        for (const fn of this.listeners) fn(m);
      }
    });
  }
  on(fn) { this.listeners.push(fn); }
  send(method, params = {}, sessionId) {
    const id = ++this.id;
    const msg = { id, method, params };
    if (sessionId) msg.sessionId = sessionId;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify(msg));
    });
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitForJson(url, timeoutMs) {
  const start = Date.now();
  let lastErr;
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(url);
      if (res.ok) return await res.json();
    } catch (e) { lastErr = e; }
    await sleep(120);
  }
  throw new Error(`timed out waiting for ${url}: ${lastErr && lastErr.message}`);
}

let httpProc, chromeProc, userDataDir, ws;
const chromeLog = [];

function cleanup() {
  try { if (ws) ws.close(); } catch (_) {}
  try { if (chromeProc) chromeProc.kill('SIGKILL'); } catch (_) {}
  try { if (httpProc) httpProc.kill('SIGKILL'); } catch (_) {}
  try { if (userDataDir && existsSync(userDataDir)) rmSync(userDataDir, { recursive: true, force: true }); } catch (_) {}
}
process.on('SIGINT', () => { cleanup(); process.exit(130); });
process.on('SIGTERM', () => { cleanup(); process.exit(143); });

async function main() {
  // 1. Serve the repo. file:// fetch is blocked, so the harness needs HTTP.
  httpProc = spawn('python3', ['-m', 'http.server', String(HTTP_PORT)], {
    cwd: REPO_ROOT, stdio: 'ignore',
  });

  // 2. Launch headless Chrome with a throwaway profile.
  if (!existsSync(CHROME)) throw new Error(`Chrome not found at ${CHROME} (set CHROME_BIN)`);
  userDataDir = mkdtempSync(join(tmpdir(), 'laid-cdp-'));
  chromeProc = spawn(CHROME, [
    '--headless=new',
    `--remote-debugging-port=${CDP_PORT}`,
    `--user-data-dir=${userDataDir}`,
    '--no-first-run', '--no-default-browser-check',
    '--disable-extensions', '--disable-background-networking',
    '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows',
    '--disable-features=Translate,BackForwardCache',
    '--window-size=1280,2000',
    'about:blank',
  ], { stdio: ['ignore', 'pipe', 'pipe'] });
  chromeProc.stdout.on('data', (d) => chromeLog.push(d.toString()));
  chromeProc.stderr.on('data', (d) => chromeLog.push(d.toString()));

  // 3. Connect to the browser-level CDP endpoint.
  const version = await waitForJson(`http://127.0.0.1:${CDP_PORT}/json/version`, 15000);
  ws = new WebSocket(version.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve, { once: true });
    ws.addEventListener('error', (e) => reject(new Error('CDP ws error: ' + (e.message || 'failed'))), { once: true });
  });
  const cdp = new CDP(ws);

  // 4. Open a page target and attach (flatten → one ws, sessionId-routed).
  const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank' });
  const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true });
  await cdp.send('Page.enable', {}, sessionId);
  await cdp.send('Runtime.enable', {}, sessionId);

  if (opts.logs) {
    cdp.on((m) => {
      if (m.method === 'Runtime.consoleAPICalled' && m.sessionId === sessionId) {
        const args = (m.params.args || []).map((a) =>
          a.value !== undefined ? a.value : a.description || a.type).join(' ');
        process.stderr.write(`[page:${m.params.type}] ${args}\n`);
      }
      if (m.method === 'Runtime.exceptionThrown' && m.sessionId === sessionId) {
        const d = m.params.exceptionDetails;
        process.stderr.write(`[page:exception] ${d.exception ? d.exception.description : d.text}\n`);
      }
    });
  }

  // 5. Navigate and wait for load.
  const loaded = new Promise((resolve) => {
    cdp.on((m) => { if (m.method === 'Page.loadEventFired' && m.sessionId === sessionId) resolve(); });
  });
  await cdp.send('Page.navigate', { url: TARGET_URL }, sessionId);
  await Promise.race([loaded, sleep(10000)]);

  // 6. Poll the ready predicate, then read the result.
  const evalExpr = async (expression) => {
    const { result, exceptionDetails } = await cdp.send('Runtime.evaluate', {
      expression, returnByValue: true, awaitPromise: true,
    }, sessionId);
    if (exceptionDetails) {
      throw new Error('page eval threw: ' +
        (exceptionDetails.exception ? exceptionDetails.exception.description : exceptionDetails.text));
    }
    return result.value;
  };

  const start = Date.now();
  let ready = false;
  while (Date.now() - start < TIMEOUT) {
    try { ready = await evalExpr(`!!(${READY})`); } catch (_) { ready = false; }
    if (ready) break;
    await sleep(150);
  }
  if (!ready) {
    throw new Error(`ready predicate never became true within ${TIMEOUT}ms: ${READY}`);
  }

  // Optional NATIVE SCROLL phase. A headless tab is normally treated as hidden, so
  // rAF/IO are throttled and programmatic scrollTop emits no scroll event (the exact
  // MCP limitation that made the old loop useless). Focus-emulation + web-lifecycle
  // 'active' un-throttle rendering, and Input.dispatchMouseEvent wheels are REAL
  // scroll input — so this reproduces a foreground scroll and measures real frame drops.
  const scrollSteps = Number(opts.scroll || 0);
  if (scrollSteps > 0) {
    const dy = Number(opts.scrollDelta || 150);
    const delay = Number(opts.scrollDelay || 50);
    const x = Number(opts.scrollX || 500), y = Number(opts.scrollY || 600);
    try { await cdp.send('Emulation.setFocusEmulationEnabled', { enabled: true }, sessionId); } catch (e) { process.stderr.write('focus-emu failed: ' + e.message + '\n'); }
    try { await cdp.send('Page.setWebLifecycleState', { state: 'active' }, sessionId); } catch (_) {}
    try { await evalExpr('window.__laidResetMonitor && window.__laidResetMonitor()'); } catch (_) {}
    process.stderr.write(`scrolling: ${scrollSteps} wheel steps (dy=${dy}, every ${delay}ms) at (${x},${y})…\n`);
    for (let i = 0; i < scrollSteps; i++) {
      await cdp.send('Input.dispatchMouseEvent', { type: 'mouseWheel', x, y, deltaX: 0, deltaY: dy }, sessionId);
      await sleep(delay);
    }
    await sleep(700); // let the final scroll settle + last scan/badge land
  }

  const value = await evalExpr(`(function(){ var r = ${RESULT}; return r; })()`);
  const pass = await evalExpr(`(function(){ var r = ${RESULT}; return !!(${PASS}); })()`);

  // stdout = pure JSON (parseable by the next stage); human notes go to stderr.
  process.stdout.write(JSON.stringify(value, null, 2) + '\n');
  process.stderr.write(`\nVERDICT: ${pass ? 'PASS' : 'FAIL'}  (${urlPath})\n`);

  if (!opts.keepOpen) {
    await cdp.send('Target.closeTarget', { targetId });
  } else {
    process.stderr.write(`[--keep-open] tab left open at ${TARGET_URL} (CDP ${CDP_PORT})\n`);
  }
  return pass ? 0 : 2;
}

main()
  .then((code) => { if (!opts.keepOpen) cleanup(); process.exit(code); })
  .catch((err) => {
    process.stderr.write(`\nERROR: ${err.message}\n`);
    if (chromeLog.length) process.stderr.write('--- chrome log ---\n' + chromeLog.join('').slice(-2000) + '\n');
    cleanup();
    process.exit(1);
  });

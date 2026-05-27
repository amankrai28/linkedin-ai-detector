#!/usr/bin/env node
/**
 * Post-build patch: esbuild emits `var import_meta = {}` because IIFE format
 * can't use `import.meta`. Transformers.js / ONNX Runtime use it to locate
 * WASM assets — replace with the same shim Xenova publishes for browser
 * builds. Portable across BSD (macOS) and GNU sed.
 */
const fs = require('fs');
const path = 'build/offscreen.js';

let s = fs.readFileSync(path, 'utf-8');
const shim = `{ url: (document.currentScript && document.currentScript.src) || location.href }`;
s = s.replace(/var import_meta(\d*) = \{\};/g, (_m, n) => `var import_meta${n} = ${shim};`);
fs.writeFileSync(path, s);

const hits = (s.match(/var import_meta\d* = \{ url:/g) || []).length;
console.log(`postbuild: patched ${hits} import_meta shim(s) in ${path}`);

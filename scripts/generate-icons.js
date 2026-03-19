/**
 * Generate extension icons as minimal valid PNGs using pure Node.js.
 * Creates a blue shield-like shape with "AI" text approximation.
 * No external dependencies required.
 */

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

function createPNG(size) {
  const pixels = Buffer.alloc(size * size * 4, 0); // RGBA

  const cx = size / 2;
  const cy = size / 2;
  const r = size * 0.42; // circle radius

  // Colors
  const bgR = 10, bgG = 102, bgB = 194; // LinkedIn blue #0a66c2
  const fgR = 255, fgG = 255, fgB = 255; // white text

  // Draw filled circle
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const dx = x - cx;
      const dy = y - cy;
      const dist = Math.sqrt(dx * dx + dy * dy);
      const idx = (y * size + x) * 4;

      if (dist <= r) {
        // Anti-aliased edge
        const alpha = dist > r - 1 ? Math.max(0, Math.min(255, Math.round((r - dist) * 255))) : 255;
        pixels[idx] = bgR;
        pixels[idx + 1] = bgG;
        pixels[idx + 2] = bgB;
        pixels[idx + 3] = alpha;
      }
    }
  }

  // Draw "AI" text as simple pixel art, scaled to size
  // Letter A and I designed on a 7x9 grid
  const letterA = [
    [0,0,1,1,1,0,0],
    [0,1,0,0,0,1,0],
    [1,0,0,0,0,0,1],
    [1,0,0,0,0,0,1],
    [1,1,1,1,1,1,1],
    [1,0,0,0,0,0,1],
    [1,0,0,0,0,0,1],
    [1,0,0,0,0,0,1],
    [1,0,0,0,0,0,1],
  ];

  const letterI = [
    [1,1,1,1,1],
    [0,0,1,0,0],
    [0,0,1,0,0],
    [0,0,1,0,0],
    [0,0,1,0,0],
    [0,0,1,0,0],
    [0,0,1,0,0],
    [0,0,1,0,0],
    [1,1,1,1,1],
  ];

  const scale = Math.max(1, Math.floor(size / 20));
  const totalW = (7 + 1 + 5) * scale; // A width + gap + I width
  const totalH = 9 * scale;
  const startX = Math.floor(cx - totalW / 2);
  const startY = Math.floor(cy - totalH / 2);

  function drawLetter(grid, offX, offY) {
    for (let gy = 0; gy < grid.length; gy++) {
      for (let gx = 0; gx < grid[gy].length; gx++) {
        if (!grid[gy][gx]) continue;
        for (let sy = 0; sy < scale; sy++) {
          for (let sx = 0; sx < scale; sx++) {
            const px = offX + gx * scale + sx;
            const py = offY + gy * scale + sy;
            if (px < 0 || px >= size || py < 0 || py >= size) continue;
            const idx = (py * size + px) * 4;
            if (pixels[idx + 3] === 0) continue; // skip if outside circle
            pixels[idx] = fgR;
            pixels[idx + 1] = fgG;
            pixels[idx + 2] = fgB;
            pixels[idx + 3] = 255;
          }
        }
      }
    }
  }

  drawLetter(letterA, startX, startY);
  drawLetter(letterI, startX + (7 + 1) * scale, startY);

  // Encode as PNG
  return encodePNG(pixels, size, size);
}

function encodePNG(pixels, width, height) {
  // Build raw scanlines (filter byte 0 = None for each row)
  const rawData = Buffer.alloc(height * (1 + width * 4));
  for (let y = 0; y < height; y++) {
    const rowOffset = y * (1 + width * 4);
    rawData[rowOffset] = 0; // filter: None
    pixels.copy(rawData, rowOffset + 1, y * width * 4, (y + 1) * width * 4);
  }

  const compressed = zlib.deflateSync(rawData);

  // PNG signature
  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

  // IHDR chunk
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // color type: RGBA
  ihdr[10] = 0; // compression
  ihdr[11] = 0; // filter
  ihdr[12] = 0; // interlace
  const ihdrChunk = makeChunk('IHDR', ihdr);

  // IDAT chunk
  const idatChunk = makeChunk('IDAT', compressed);

  // IEND chunk
  const iendChunk = makeChunk('IEND', Buffer.alloc(0));

  return Buffer.concat([signature, ihdrChunk, idatChunk, iendChunk]);
}

function makeChunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);

  const typeBuffer = Buffer.from(type, 'ascii');
  const crcInput = Buffer.concat([typeBuffer, data]);

  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(crcInput), 0);

  return Buffer.concat([length, typeBuffer, data, crc]);
}

function crc32(buf) {
  let crc = 0xFFFFFFFF;
  for (let i = 0; i < buf.length; i++) {
    crc ^= buf[i];
    for (let j = 0; j < 8; j++) {
      crc = (crc >>> 1) ^ (crc & 1 ? 0xEDB88320 : 0);
    }
  }
  return (crc ^ 0xFFFFFFFF) >>> 0;
}

// Generate icons
const iconsDir = path.join(__dirname, '..', 'icons');

for (const size of [16, 48, 128]) {
  const png = createPNG(size);
  const filePath = path.join(iconsDir, `icon${size}.png`);
  fs.writeFileSync(filePath, png);
  console.log(`Generated ${filePath} (${png.length} bytes)`);
}

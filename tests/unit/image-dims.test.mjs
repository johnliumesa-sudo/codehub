// Regression: decompression-bomb guard reads dimensions from image headers without decoding.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readDims, assertDims } from '../../src/lib/media/image.js';

const png = (w, h) => {
  const b = new Uint8Array(33);
  b.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]);
  new DataView(b.buffer).setUint32(16, w); new DataView(b.buffer).setUint32(20, h);
  return b;
};
const gif = (w, h) => { const b = new Uint8Array(13); b.set([0x47, 0x49, 0x46, 0x38, 0x39, 0x61]); const v = new DataView(b.buffer); v.setUint16(6, w, true); v.setUint16(8, h, true); return b; };
const jpeg = (w, h) => new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 4, 0, 0, 0xff, 0xc0, 0, 11, 8, h >> 8, h & 255, w >> 8, w & 255, 3, 0, 0, 0]);
const webpX = (w, h) => {
  const b = new Uint8Array(30); b.set([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50, 0x56, 0x50, 0x38, 0x58]);
  const W = w - 1, H = h - 1; b.set([W & 255, (W >> 8) & 255, W >> 16, H & 255, (H >> 8) & 255, H >> 16], 24); return b;
};

test('readDims parses PNG, GIF, JPEG, WebP headers', () => {
  assert.deepEqual(readDims(png(800, 600)), { w: 800, h: 600 });
  assert.deepEqual(readDims(gif(64, 32)), { w: 64, h: 32 });
  assert.deepEqual(readDims(jpeg(1600, 900)), { w: 1600, h: 900 });
  assert.deepEqual(readDims(webpX(12000, 12000)), { w: 12000, h: 12000 });
  assert.equal(readDims(new Uint8Array([1, 2, 3])), null);
});

test('assertDims refuses oversized images and unknown headers when required', () => {
  assert.throws(() => assertDims(png(12000, 12000), { maxDim: 1600 }));
  assert.throws(() => assertDims(png(10000, 10000), { maxPixels: 50e6 }));
  assert.doesNotThrow(() => assertDims(png(1600, 1200), { maxDim: 1600 }));
  assert.throws(() => assertDims(new Uint8Array(8), { requireKnown: true }));
});

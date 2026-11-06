// Hand-written ZIP support (no dependencies).
//
//   makeZip(entries)            -> Blob     store-only (method 0) archive, UTF-8 names (flag bit 11)
//   readZip(arrayBuffer, opts?) -> Promise<[{ path, bytes } | { path, bytes: null, error }]>
//
// The writer never compresses: workspace exports are small text files and STORED keeps the
// format trivial. The reader understands STORED and DEFLATE (via the browser's
// DecompressionStream('deflate-raw')), refuses ZIP64 / encrypted / multi-disk archives, verifies
// CRC32 and caps the inflated size of every entry, so a zip bomb cannot exhaust memory.

// ---------- CRC32 (IEEE 802.3, reflected, poly 0xEDB88320) ----------

let CRC_TABLE = null;

function crcTable() {
  if (CRC_TABLE) return CRC_TABLE;
  CRC_TABLE = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    CRC_TABLE[n] = c >>> 0;
  }
  return CRC_TABLE;
}

export function crc32(bytes) {
  const t = crcTable();
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = t[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

// ---------- helpers ----------

const enc = new TextEncoder();
const SIG_LOCAL = 0x04034b50;
const SIG_CENTRAL = 0x02014b50;
const SIG_EOCD = 0x06054b50;
const FLAG_UTF8 = 0x0800;
const FLAG_ENCRYPTED = 0x0001;
const MAX_ENTRIES = 0xffff; // no ZIP64

function dosDateTime(d = new Date()) {
  const year = Math.max(1980, Math.min(2107, d.getFullYear()));
  const time = (d.getHours() << 11) | (d.getMinutes() << 5) | Math.floor(d.getSeconds() / 2);
  const date = ((year - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();
  return { time: time & 0xffff, date: date & 0xffff };
}

function toBytes(data) {
  if (data instanceof Uint8Array) return data;
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  return enc.encode(String(data ?? ''));
}

// ---------- writer ----------

/**
 * entries: [{ path: string, data: string | Uint8Array | ArrayBuffer, date?: Date }]
 * Paths use forward slashes and must be relative; leading slashes and `..` segments are dropped.
 */
export function makeZip(entries) {
  if (entries.length > MAX_ENTRIES) throw new Error(`Too many files for a zip (${entries.length})`);
  const parts = [];
  const central = [];
  let offset = 0;
  const seen = new Set();

  for (const entry of entries) {
    const path = String(entry.path || '')
      .replace(/\\/g, '/')
      .split('/')
      .filter((s) => s && s !== '.' && s !== '..')
      .join('/');
    if (!path || seen.has(path)) continue;
    seen.add(path);
    const name = enc.encode(path);
    const data = toBytes(entry.data);
    if (name.length > 0xffff) throw new Error(`File name too long: ${path.slice(0, 40)}…`);
    if (data.length >= 0xffffffff || offset >= 0xffffffff) throw new Error('Archive too large (ZIP64 is not supported)');
    const crc = crc32(data);
    const { time, date } = dosDateTime(entry.date);

    const local = new DataView(new ArrayBuffer(30));
    local.setUint32(0, SIG_LOCAL, true);
    local.setUint16(4, 20, true); // version needed: 2.0
    local.setUint16(6, FLAG_UTF8, true);
    local.setUint16(8, 0, true); // method: stored
    local.setUint16(10, time, true);
    local.setUint16(12, date, true);
    local.setUint32(14, crc, true);
    local.setUint32(18, data.length, true); // compressed size
    local.setUint32(22, data.length, true); // uncompressed size
    local.setUint16(26, name.length, true);
    local.setUint16(28, 0, true); // extra length
    parts.push(new Uint8Array(local.buffer), name, data);

    const cd = new DataView(new ArrayBuffer(46));
    cd.setUint32(0, SIG_CENTRAL, true);
    cd.setUint16(4, 20, true); // version made by (MS-DOS / 2.0)
    cd.setUint16(6, 20, true); // version needed
    cd.setUint16(8, FLAG_UTF8, true);
    cd.setUint16(10, 0, true);
    cd.setUint16(12, time, true);
    cd.setUint16(14, date, true);
    cd.setUint32(16, crc, true);
    cd.setUint32(20, data.length, true);
    cd.setUint32(24, data.length, true);
    cd.setUint16(28, name.length, true);
    cd.setUint16(30, 0, true); // extra
    cd.setUint16(32, 0, true); // comment
    cd.setUint16(34, 0, true); // disk number start
    cd.setUint16(36, 0, true); // internal attrs
    cd.setUint32(38, 0, true); // external attrs
    cd.setUint32(42, offset, true); // local header offset
    central.push(new Uint8Array(cd.buffer), name);

    offset += 30 + name.length + data.length;
  }

  const cdStart = offset;
  const cdSize = central.reduce((n, p) => n + p.length, 0);
  if (cdStart + cdSize >= 0xffffffff) throw new Error('Archive too large (ZIP64 is not supported)');
  const count = seen.size;
  const eocd = new DataView(new ArrayBuffer(22));
  eocd.setUint32(0, SIG_EOCD, true);
  eocd.setUint16(4, 0, true);
  eocd.setUint16(6, 0, true);
  eocd.setUint16(8, count, true);
  eocd.setUint16(10, count, true);
  eocd.setUint32(12, cdSize, true);
  eocd.setUint32(16, cdStart, true);
  eocd.setUint16(20, 0, true);

  return new Blob([...parts, ...central, new Uint8Array(eocd.buffer)], { type: 'application/zip' });
}

// ---------- reader ----------

export class ZipError extends Error {
  constructor(msg) {
    super(msg);
    this.name = 'ZipError';
  }
}

function findEocd(view) {
  const min = Math.max(0, view.byteLength - (22 + 0xffff));
  for (let i = view.byteLength - 22; i >= min; i--) {
    if (view.getUint32(i, true) === SIG_EOCD) return i;
  }
  return -1;
}

const utf8 = new TextDecoder('utf-8');

/** Inflate raw-deflate bytes, aborting once the output exceeds `limit` bytes. */
async function inflateRaw(bytes, limit) {
  if (typeof DecompressionStream === 'undefined') {
    throw new ZipError('This browser cannot read compressed zip entries');
  }
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
  const reader = stream.getReader();
  const chunks = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.length;
      if (total > limit) {
        reader.cancel().catch(() => {});
        return { tooLarge: true };
      }
      chunks.push(value);
    }
  } catch {
    throw new ZipError('corrupt compressed data');
  }
  const out = new Uint8Array(total);
  let o = 0;
  for (const c of chunks) {
    out.set(c, o);
    o += c.length;
  }
  return { bytes: out };
}

/**
 * Read every file entry of a zip archive.
 * opts.maxEntrySize (bytes, default 900_000): larger entries come back as { path, bytes: null, error: 'too-large' }.
 * opts.maxEntries (default 2000): more file entries than this throws.
 * Directory entries are skipped. Other per-entry problems come back as { path, bytes: null, error }.
 */
export async function readZip(arrayBuffer, opts = {}) {
  const maxEntrySize = opts.maxEntrySize ?? 900_000;
  const maxEntries = opts.maxEntries ?? 2000;
  const buf = arrayBuffer instanceof Uint8Array ? arrayBuffer : new Uint8Array(arrayBuffer);
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  if (buf.byteLength < 22) throw new ZipError('Not a zip file');
  const eocd = findEocd(view);
  if (eocd < 0) throw new ZipError('Not a zip file (no end of central directory)');
  const disk = view.getUint16(eocd + 4, true);
  const cdDisk = view.getUint16(eocd + 6, true);
  const total = view.getUint16(eocd + 10, true);
  const cdSize = view.getUint32(eocd + 12, true);
  const cdOffset = view.getUint32(eocd + 16, true);
  if (disk !== 0 || cdDisk !== 0) throw new ZipError('Multi-part zip archives are not supported');
  if (total === 0xffff || cdOffset === 0xffffffff || cdSize === 0xffffffff) throw new ZipError('ZIP64 archives are not supported');
  if (cdOffset + cdSize > buf.byteLength) throw new ZipError('Truncated zip archive');

  const out = [];
  let p = cdOffset;
  let files = 0;
  for (let i = 0; i < total; i++) {
    if (p + 46 > buf.byteLength || view.getUint32(p, true) !== SIG_CENTRAL) throw new ZipError('Corrupt central directory');
    const flags = view.getUint16(p + 8, true);
    const method = view.getUint16(p + 10, true);
    const crc = view.getUint32(p + 16, true);
    const compSize = view.getUint32(p + 20, true);
    const size = view.getUint32(p + 24, true);
    const nameLen = view.getUint16(p + 28, true);
    const extraLen = view.getUint16(p + 30, true);
    const commentLen = view.getUint16(p + 32, true);
    const localOffset = view.getUint32(p + 42, true);
    const rawName = buf.subarray(p + 46, p + 46 + nameLen);
    p += 46 + nameLen + extraLen + commentLen;

    const path = utf8.decode(rawName).replace(/\\/g, '/');
    if (!path || path.endsWith('/')) continue; // directory
    // macOS Finder metadata: never useful in a workspace.
    if (path.startsWith('__MACOSX/') || path.split('/').pop() === '.DS_Store') continue;
    if (++files > maxEntries) throw new ZipError(`The archive has more than ${maxEntries} files`);

    if (flags & FLAG_ENCRYPTED) {
      out.push({ path, bytes: null, error: 'encrypted' });
      continue;
    }
    if (compSize === 0xffffffff || size === 0xffffffff || localOffset === 0xffffffff) {
      out.push({ path, bytes: null, error: 'zip64' });
      continue;
    }
    if (size > maxEntrySize) {
      out.push({ path, bytes: null, error: 'too-large', size });
      continue;
    }
    if (localOffset + 30 > buf.byteLength || view.getUint32(localOffset, true) !== SIG_LOCAL) {
      out.push({ path, bytes: null, error: 'corrupt' });
      continue;
    }
    const lNameLen = view.getUint16(localOffset + 26, true);
    const lExtraLen = view.getUint16(localOffset + 28, true);
    const start = localOffset + 30 + lNameLen + lExtraLen;
    if (start + compSize > buf.byteLength) {
      out.push({ path, bytes: null, error: 'corrupt' });
      continue;
    }
    const raw = buf.subarray(start, start + compSize);

    let bytes;
    if (method === 0) {
      if (compSize !== size) {
        out.push({ path, bytes: null, error: 'corrupt' });
        continue;
      }
      bytes = raw.slice();
    } else if (method === 8) {
      try {
        const r = await inflateRaw(raw, maxEntrySize);
        if (r.tooLarge) {
          out.push({ path, bytes: null, error: 'too-large', size });
          continue;
        }
        bytes = r.bytes;
      } catch (err) {
        out.push({ path, bytes: null, error: err instanceof ZipError ? err.message : 'corrupt' });
        continue;
      }
    } else {
      out.push({ path, bytes: null, error: `unsupported compression (method ${method})` });
      continue;
    }
    if (bytes.length !== size || crc32(bytes) !== crc) {
      out.push({ path, bytes: null, error: 'checksum mismatch' });
      continue;
    }
    out.push({ path, bytes });
  }
  return out;
}

/** Trigger a browser download for a Blob. */
export function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.rel = 'noopener';
  a.style.display = 'none';
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30_000);
}

/** A file name safe on every OS, for `<title>.zip`. */
export function safeFileName(name, fallback = 'workspace') {
  const s = String(name || '')
    .replace(/[\\/:*?"<>|\u0000-\u001f]+/g, '-')
    .replace(/\s+/g, ' ')
    .replace(/^[\s.-]+|[\s.-]+$/g, '')
    .slice(0, 80);
  return s || fallback;
}

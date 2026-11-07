// SHA-256 of add-on code (hex), used to pin exactly the version a user or server approved.
// Works in browsers and in Node (globalThis.crypto.subtle).

const hex = (buf) => Array.from(new Uint8Array(buf), (b) => b.toString(16).padStart(2, '0')).join('');

/** Lower-case hex SHA-256 of the UTF-8 bytes of `text`. */
export async function sha256Hex(text) {
  const data = new TextEncoder().encode(String(text ?? ''));
  return hex(await globalThis.crypto.subtle.digest('SHA-256', data));
}

/** True when `code` hashes to `sha`. */
export async function shaMatches(code, sha) {
  return typeof code === 'string' && typeof sha === 'string' && (await sha256Hex(code)) === sha;
}

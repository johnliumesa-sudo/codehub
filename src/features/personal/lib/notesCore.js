// Private user notes: pure helpers (no Firebase imports; unit-tested in node).

export const NOTE_MAX = 1000;
export const noteAad = (me, uid) => `unote:${me}/${uid}`;

/** Normalize note text: no control characters except newlines, trimmed, at most NOTE_MAX characters. */
export function cleanNote(v) {
  if (typeof v !== 'string') return '';
  const t = v.replace(/\r\n?/g, '\n').replace(/[\u0000-\u0009\u000b-\u001f\u007f\u202a-\u202e\u2066-\u2069]/g, '').trim();
  return Array.from(t).slice(0, NOTE_MAX).join('').trim();
}

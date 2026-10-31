// Line diff (Myers O(ND)) with unified-style hunks.
// diffLines(a, b) -> { hunks: [{ oldStart, newStart, lines: [{type:' '|'-'|'+', text, oldNo?, newNo?}] }],
//                     added, removed, tooLarge }

const MAX_D = 2500;

function myers(a, b) {
  const N = a.length;
  const M = b.length;
  const max = N + M;
  const off = max + 1;
  const v = new Int32Array(2 * max + 3);
  const trace = [];
  for (let d = 0; d <= max; d++) {
    if (d > MAX_D) return null;
    trace.push(v.slice(off - d - 1, off + d + 2)); // values of v[k] for k in [-d-1, d+1] before step d
    for (let k = -d; k <= d; k += 2) {
      let x = k === -d || (k !== d && v[off + k - 1] < v[off + k + 1]) ? v[off + k + 1] : v[off + k - 1] + 1;
      let y = x - k;
      while (x < N && y < M && a[x] === b[y]) {
        x++;
        y++;
      }
      v[off + k] = x;
      if (x >= N && y >= M) return backtrack(trace, a, b, d);
    }
  }
  return null;
}

function backtrack(trace, a, b, D) {
  const ops = [];
  let x = a.length;
  let y = b.length;
  for (let d = D; d > 0; d--) {
    const t = trace[d];
    const get = (k) => t[k + d + 1];
    const k = x - y;
    const prevK = k === -d || (k !== d && get(k - 1) < get(k + 1)) ? k + 1 : k - 1;
    const prevX = get(prevK);
    const prevY = prevX - prevK;
    while (x > prevX && y > prevY) {
      ops.push([' ', x - 1, y - 1]);
      x--;
      y--;
    }
    if (x === prevX) ops.push(['+', -1, y - 1]);
    else ops.push(['-', x - 1, -1]);
    x = prevX;
    y = prevY;
  }
  while (x > 0 && y > 0) {
    ops.push([' ', x - 1, y - 1]);
    x--;
    y--;
  }
  return ops.reverse();
}

export function splitLines(text) {
  const lines = String(text ?? '').replace(/\r\n/g, '\n').split('\n');
  if (lines.length > 1 && lines[lines.length - 1] === '') lines.pop();
  return lines;
}

export function diffLines(oldText, newText, context = 3) {
  const a = splitLines(oldText);
  const b = splitLines(newText);
  // Trim common prefix/suffix to keep the core diff small.
  let pre = 0;
  while (pre < a.length && pre < b.length && a[pre] === b[pre]) pre++;
  let suf = 0;
  while (suf < a.length - pre && suf < b.length - pre && a[a.length - 1 - suf] === b[b.length - 1 - suf]) suf++;
  const core = myers(a.slice(pre, a.length - suf), b.slice(pre, b.length - suf));
  if (!core) return { hunks: [], added: 0, removed: 0, tooLarge: true };

  const ops = [];
  for (let i = 0; i < pre; i++) ops.push([' ', i, i]);
  for (const [t, x, y] of core) ops.push([t, x < 0 ? -1 : x + pre, y < 0 ? -1 : y + pre]);
  for (let i = 0; i < suf; i++) ops.push([' ', a.length - suf + i, b.length - suf + i]);

  let added = 0;
  let removed = 0;
  const lines = ops.map(([t, x, y]) => {
    if (t === '+') added++;
    if (t === '-') removed++;
    return { type: t, text: t === '+' ? b[y] : a[x], oldNo: x >= 0 ? x + 1 : undefined, newNo: y >= 0 ? y + 1 : undefined };
  });

  // Group into hunks with `context` unchanged lines around each change.
  const hunks = [];
  let cur = null;
  let lastChange = -Infinity;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].type === ' ') continue;
    const start = Math.max(0, i - context);
    if (cur && start <= lastChange + context + 1) {
      for (let j = lastChange + 1; j <= i; j++) cur.lines.push(lines[j]);
    } else {
      if (cur) {
        for (let j = lastChange + 1; j <= Math.min(lines.length - 1, lastChange + context); j++) cur.lines.push(lines[j]);
        hunks.push(cur);
      }
      cur = { lines: lines.slice(start, i + 1) };
    }
    lastChange = i;
  }
  if (cur) {
    for (let j = lastChange + 1; j <= Math.min(lines.length - 1, lastChange + context); j++) cur.lines.push(lines[j]);
    hunks.push(cur);
  }
  for (const h of hunks) {
    const firstOld = h.lines.find((l) => l.oldNo);
    const firstNew = h.lines.find((l) => l.newNo);
    h.oldStart = firstOld ? firstOld.oldNo : 0;
    h.newStart = firstNew ? firstNew.newNo : 0;
  }
  return { hunks, added, removed, tooLarge: false };
}

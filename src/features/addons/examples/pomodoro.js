// Pomodoro timer: a Codehub example add-on (runtime 2: this code runs in a worker and draws with
// codehub.ui.render). Focus sessions with short and long breaks. With the "storage" permission it
// keeps its end time in the add-on's private storage, so it keeps counting while the panel is closed.
var MODES = { focus: 25 * 60, short: 5 * 60, long: 15 * 60 };
var LABEL = { focus: 'Focus', short: 'Short break', long: 'Long break' };
var C = 2 * Math.PI * 52;
var state = { mode: 'focus', endsAt: 0, left: MODES.focus, done: 0 };
var canStore = false;
var note = '';
var lastDrawn = '';
var esc = codehub.ui.escape;

var STYLE =
  '<style>' +
  '* { box-sizing: border-box; }' +
  'html, body { height: 100%; }' +
  'body { padding: 16px; background: var(--ch-bg-1, #11141b); color: var(--ch-text, #e6e9f0); }' +
  '.app { min-height: 100%; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 14px; }' +
  '.modes { display: flex; flex-wrap: wrap; justify-content: center; gap: 4px; padding: 3px; border-radius: 999px; background: var(--ch-bg-3, #1d2230); }' +
  '.modes button { border: 0; border-radius: 999px; padding: 5px 10px; background: transparent; color: var(--ch-text-dim, #9aa3b5); font: inherit; font-size: 12px; cursor: pointer; }' +
  '.modes button[aria-pressed="true"] { background: var(--ch-accent, #5b8cff); color: #fff; }' +
  '.ring { position: relative; width: 180px; height: 180px; max-width: 70vw; max-height: 70vw; }' +
  '.ring svg { width: 100%; height: 100%; transform: rotate(-90deg); }' +
  '.ring circle { fill: none; stroke-width: 10; }' +
  '.ring .track { stroke: var(--ch-bg-3, #1d2230); }' +
  '.ring .bar { stroke: var(--ch-accent, #5b8cff); stroke-linecap: round; transition: stroke-dashoffset .25s linear; }' +
  '.app.break .ring .bar { stroke: var(--ch-ok, #3ccf91); }' +
  '.time { position: absolute; inset: 0; display: grid; place-items: center; font-size: 40px; font-weight: 700; font-variant-numeric: tabular-nums; }' +
  '.controls { display: flex; gap: 8px; }' +
  '.controls button { min-width: 84px; padding: 8px 14px; border-radius: 8px; border: 1px solid var(--ch-border, #262d3d); background: var(--ch-bg-3, #1d2230); color: inherit; font: inherit; cursor: pointer; }' +
  '.controls button.primary { background: var(--ch-accent, #5b8cff); border-color: var(--ch-accent, #5b8cff); color: #fff; }' +
  'button:focus-visible { outline: 2px solid var(--ch-accent, #5b8cff); outline-offset: 2px; }' +
  '.meta { margin: 0; min-height: 1.4em; color: var(--ch-text-dim, #9aa3b5); font-size: 12px; text-align: center; }' +
  '@media (prefers-reduced-motion: reduce) { .ring .bar { transition: none; } }' +
  '</style>';

function remaining() {
  return state.endsAt ? Math.max(0, Math.round((state.endsAt - Date.now()) / 1000)) : state.left;
}

function fmt(s) {
  var m = Math.floor(s / 60);
  var r = s % 60;
  return (m < 10 ? '0' : '') + m + ':' + (r < 10 ? '0' : '') + r;
}

function save() {
  if (canStore) codehub.storage.set('state', state).catch(function () {});
}

function say(text) {
  note = text;
  draw();
}

function draw() {
  var left = remaining();
  var modes = ['focus', 'short', 'long']
    .map(function (m) {
      return '<button type="button" data-on="click" data-id="mode:' + m + '" aria-pressed="' + (m === state.mode) + '">' + LABEL[m] + '</button>';
    })
    .join('');
  var toggle = state.endsAt ? 'Pause' : left < MODES[state.mode] ? 'Resume' : 'Start';
  var offset = (C * (1 - left / MODES[state.mode])).toFixed(2);
  var html =
    STYLE +
    '<div class="app' + (state.mode !== 'focus' ? ' break' : '') + '">' +
    '<div class="modes" role="group" aria-label="Timer mode">' + modes + '</div>' +
    '<div class="ring"><svg viewBox="0 0 120 120" aria-hidden="true">' +
    '<circle class="track" cx="60" cy="60" r="52"></circle>' +
    '<circle class="bar" cx="60" cy="60" r="52" stroke-dasharray="' + C.toFixed(2) + '" stroke-dashoffset="' + offset + '"></circle>' +
    '</svg><div class="time" id="time" role="timer" aria-live="off">' + fmt(left) + '</div></div>' +
    '<div class="controls">' +
    '<button type="button" class="primary" data-on="click" data-id="toggle">' + toggle + '</button>' +
    '<button type="button" data-on="click" data-id="reset">Reset</button>' +
    '</div>' +
    '<p class="meta" id="meta" aria-live="polite">' + esc(note) + '</p>' +
    '</div>';
  if (html === lastDrawn) return;
  lastDrawn = html;
  codehub.ui.render(html);
}

function setMode(mode) {
  state.mode = mode;
  state.endsAt = 0;
  state.left = MODES[mode];
  save();
  draw();
}

function finish() {
  if (state.mode === 'focus') {
    state.done += 1;
    setMode(state.done % 4 === 0 ? 'long' : 'short');
    say('Focus session done. Time for a break. Sessions today: ' + state.done + '.');
  } else {
    setMode('focus');
    say('Break over. Ready for the next focus session?');
  }
}

codehub.ui.on(function (e) {
  if (e.type !== 'click') return;
  if (e.id === 'toggle') {
    if (state.endsAt) {
      state.left = remaining();
      state.endsAt = 0;
      note = 'Paused.';
    } else {
      state.endsAt = Date.now() + remaining() * 1000;
      note = LABEL[state.mode] + ' started.';
    }
    save();
    draw();
  } else if (e.id === 'reset') {
    setMode(state.mode);
    say('Reset.');
  } else if (e.id.indexOf('mode:') === 0 && MODES[e.id.slice(5)]) {
    var mode = e.id.slice(5);
    setMode(mode);
    say(LABEL[mode] + ' selected.');
  }
});

setInterval(function () {
  if (state.endsAt && remaining() === 0) finish();
  else draw();
}, 250);

draw();
codehub
  .ready()
  .then(function (info) {
    canStore = info.perms.indexOf('storage') >= 0;
    if (!canStore) {
      say('Storage permission not granted: the timer resets when the panel closes.');
      return undefined;
    }
    return codehub.storage.get('state').then(function (saved) {
      if (saved && MODES[saved.mode]) {
        state = {
          mode: saved.mode,
          endsAt: Number(saved.endsAt) || 0,
          left: Math.min(MODES[saved.mode], Number(saved.left) || MODES[saved.mode]),
          done: Number(saved.done) || 0,
        };
        if (state.endsAt && state.endsAt <= Date.now()) finish();
      }
      say('Sessions completed: ' + state.done + '. Your timer keeps running while this panel is closed.');
    });
  })
  .catch(function (e) {
    say('Could not load your saved timer: ' + e.message);
  });

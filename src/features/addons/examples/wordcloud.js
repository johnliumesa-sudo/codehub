// Channel word cloud: a Codehub example add-on (runtime 2: this code runs in a worker and draws with
// codehub.ui.render). Shows the 40 most used words of the last 100 messages in the conversation
// where it is open and refreshes as people talk. Needs the "readMessages" permission; everything is
// computed in the worker, which has no network access.
var STOP = (
  'a about after again all also am an and any are as at be because been before being but by can could did do does ' +
  'doing done for from get got had has have he her here him his how i if im in into is it its ive just let lets like me more ' +
  'most my no not now of off ok okay on one only or other our out over please really same see she should so some still such ' +
  'than thanks that thats the their them then there these they this those though through to too up us very was we were what ' +
  'when where which while who why will with would yeah yes you your youre dont cant wont isnt didnt doesnt'
).split(' ');
var stop = {};
STOP.forEach(function (w) {
  stop[w] = true;
});
var esc = codehub.ui.escape;
var status = 'Loading…';
var cloud = null; // [{ word, count }] once loaded
var timer = null;

var STYLE =
  '<style>' +
  '* { box-sizing: border-box; }' +
  'body { padding: 14px; background: var(--ch-bg-1, #11141b); color: var(--ch-text, #e6e9f0); }' +
  'header { display: flex; align-items: center; justify-content: space-between; gap: 8px; margin-bottom: 10px; }' +
  'h1 { margin: 0; font-size: 14px; }' +
  '.sub { color: var(--ch-text-dim, #9aa3b5); font-size: 12px; margin: 2px 0 0; }' +
  'button { padding: 5px 10px; border-radius: 6px; border: 1px solid var(--ch-border, #262d3d); background: var(--ch-bg-3, #1d2230); color: inherit; font: inherit; font-size: 12px; cursor: pointer; }' +
  'button:focus-visible { outline: 2px solid var(--ch-accent, #5b8cff); outline-offset: 2px; }' +
  '#cloud { display: flex; flex-wrap: wrap; align-items: baseline; justify-content: center; gap: 4px 10px; padding: 12px 4px; margin: 0; list-style: none; }' +
  '#cloud li { line-height: 1.1; font-weight: 600; overflow-wrap: anywhere; }' +
  '.sr { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; }' +
  '.c0 { color: var(--ch-accent, #5b8cff); } .c1 { color: var(--ch-accent-2, #a66bff); } .c2 { color: var(--ch-ok, #3ccf91); }' +
  '.c3 { color: var(--ch-warn, #f5c542); } .c4 { color: var(--ch-text, #e6e9f0); } .c5 { color: var(--ch-danger, #ff5c7a); }' +
  '#cloud li.empty { color: var(--ch-text-dim, #9aa3b5); font-weight: 400; text-align: center; padding: 24px 8px; }' +
  '</style>';

function words(text) {
  return text
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`[^`]*`/g, ' ')
    .replace(/https?:\/\/\S+/g, ' ')
    .replace(/[@#][\w-]+/g, ' ')
    .toLowerCase()
    .replace(/[’']/g, '')
    .split(/[^\p{L}\p{N}]+/u)
    .filter(function (w) {
      return w.length > 2 && !stop[w] && !/^\d+$/.test(w);
    });
}

function count(messages) {
  var counts = {};
  messages.forEach(function (m) {
    words(m.text).forEach(function (w) {
      counts[w] = (counts[w] || 0) + 1;
    });
  });
  return Object.keys(counts)
    .sort(function (a, b) {
      return counts[b] - counts[a] || a.localeCompare(b);
    })
    .slice(0, 40)
    .map(function (w) {
      return { word: w, count: counts[w] };
    });
}

function draw() {
  var items = '';
  if (cloud && !cloud.length) items = '<li class="empty">No words to show yet. Say something!</li>';
  else if (cloud) {
    var max = cloud[0].count;
    var min = cloud[cloud.length - 1].count;
    items = cloud
      .slice()
      .sort(function (a, b) {
        return a.word.localeCompare(b.word);
      })
      .map(function (it, i) {
        var t = max === min ? 0.5 : (it.count - min) / (max - min);
        var times = it.count === 1 ? ' time' : ' times';
        return (
          '<li class="c' + (i % 6) + '" style="font-size:' + (12 + Math.round(t * 22)) + 'px" data-key="w-' + esc(it.word) + '" title="' + it.count + ' × ' + esc(it.word) + '">' +
          esc(it.word) + '<span class="sr">, used ' + it.count + times + '</span></li>'
        );
      })
      .join('');
  }
  codehub.ui.render(
    STYLE +
      '<header><div><h1 id="heading">Word cloud</h1><p class="sub" id="sub" aria-live="polite">' + esc(status) + '</p></div>' +
      '<button type="button" data-on="click" data-id="refresh">Refresh</button></header>' +
      '<ul id="cloud" aria-label="Most used words">' + items + '</ul>',
  );
}

function refresh() {
  return codehub.getMessages(100).then(
    function (messages) {
      cloud = count(messages);
      status = 'From the last ' + messages.length + ' message' + (messages.length === 1 ? '' : 's') + '.';
      draw();
    },
    function (e) {
      status = e.code === 'PERMISSION_DENIED' ? 'This add-on needs the “Read messages” permission.' : 'Could not read messages: ' + e.message;
      draw();
    },
  );
}

codehub.ui.on(function (e) {
  if (e.type === 'click' && e.id === 'refresh') refresh();
});
codehub.on('messages', function () {
  clearTimeout(timer);
  timer = setTimeout(refresh, 800);
});

draw();
codehub.ready().then(refresh);

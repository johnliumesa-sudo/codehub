// First-party example add-ons shipped with Codehub. An app admin publishes them to the directory
// from Admin panel → Add-ons ("seed"); they are then ordinary add-ons published by that admin.
import pomodoro from './pomodoro.html?raw';
import wordcloud from './wordcloud.html?raw';

export const EXAMPLES = Object.freeze([
  {
    seed: 'pomodoro',
    name: 'Pomodoro timer',
    icon: '🍅',
    version: '1.0.0',
    desc: 'A focus timer: 25-minute sessions with short and long breaks. Remembers where you were with its own private storage, so it keeps counting while the panel is closed.',
    perms: ['storage'],
    code: pomodoro,
  },
  {
    seed: 'wordcloud',
    name: 'Channel word cloud',
    icon: '☁️',
    version: '1.0.0',
    desc: 'Shows the most used words of the last 100 messages in the conversation where you open it, and updates as people talk. Everything is computed in your browser.',
    perms: ['readMessages'],
    code: wordcloud,
  },
]);

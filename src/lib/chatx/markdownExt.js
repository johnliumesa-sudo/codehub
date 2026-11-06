// Marked extension: ||spoiler|| inline text. Quotes (`> text`) already render as <blockquote>.
// Register on the instance in lib/markdown.js: marked.use(spoilerExtension). Output is a <span class="spoiler">
// (class is allowed by the sanitizer); reveal on click via bindSpoilers(container).
const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

export const spoilerExtension = {
  extensions: [
    {
      name: 'spoiler',
      level: 'inline',
      start(src) {
        const i = src.indexOf('||');
        return i < 0 ? undefined : i;
      },
      tokenizer(src) {
        const m = /^\|\|(?!\s)([^|\n]+?)\|\|/.exec(src);
        if (!m) return undefined;
        return { type: 'spoiler', raw: m[0], text: m[1], tokens: this.lexer.inlineTokens(m[1]) };
      },
      renderer(token) {
        return `<span class="spoiler" title="Click to reveal">${this.parser.parseInline(token.tokens) || esc(token.text)}</span>`;
      },
    },
  ],
};

/** Delegated click handler; returns an unbind fn. */
export function bindSpoilers(container) {
  if (!container) return () => {};
  const onClick = (e) => {
    const el = e.target.closest?.('.spoiler');
    if (el && container.contains(el)) el.classList.toggle('revealed');
  };
  container.addEventListener('click', onClick);
  return () => container.removeEventListener('click', onClick);
}

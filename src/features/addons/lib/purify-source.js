// DOMPurify's browser build as text: the add-on frame inlines it (runtime.js frameDocument) and pins
// it by hash in the frame's CSP. Imported only by the lazily loaded add-on UI.
import source from 'dompurify/dist/purify.min.js?raw';

export default source;

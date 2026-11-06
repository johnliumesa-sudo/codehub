// Small "Forwarded from X" label above a forwarded message body. Props: fwd (decrypted body.fwd).
import { sanitizeFwd } from '../../lib/chatx/forward.js';
import './chatx.css';

export default function ForwardedTag({ fwd }) {
  const f = sanitizeFwd(fwd);
  if (!f) return null;
  return <div className="cx-fwd-tag">Forwarded from {f.from}</div>;
}

// A bot's avatar: its small uploaded image (validated by the shared image helpers) or its glyph.
import { useMemo } from 'react';
import { dataUrl } from '../../../lib/media/image.js';
import { DEFAULT_GLYPH } from '../lib/schema.js';

export default function BotAvatar({ glyph, image, size = 40, className = '' }) {
  const src = useMemo(() => (image ? dataUrl(image.imgType, image.img) : null), [image]);
  if (src) {
    return <img className={`bt-avatar img ${className}`} src={src} width={size} height={size} alt="" draggable={false} />;
  }
  return (
    <span className={`bt-avatar ${className}`} style={{ width: size, height: size, fontSize: Math.round(size * 0.56) }} aria-hidden="true">
      {glyph || DEFAULT_GLYPH}
    </span>
  );
}

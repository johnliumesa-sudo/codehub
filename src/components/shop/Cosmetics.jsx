// Cosmetic add-ons shown next to a user's name: badge glyph (rendered as plain TEXT, never HTML)
// and display-name color. Both come from the public `equipped/{uid}` resolved against the catalog.
import { useCosmetics } from '../../lib/shop.js';
import './shop.css';

/** Badge glyph for `uid`, or nothing. Props: { uid, className?, size? ('sm'|'md'|'lg') } */
export function CosmeticBadge({ uid, className = '', size = 'sm' }) {
  const { badgeGlyph, badgeName } = useCosmetics(uid);
  if (!badgeGlyph) return null;
  return (
    <span className={`shop-badge ${size} ${className}`} title={badgeName ? `Badge: ${badgeName}` : 'Badge'} aria-label={badgeName ? `Badge: ${badgeName}` : 'Badge'} role="img">
      {badgeGlyph}
    </span>
  );
}

/** Equipped display-name color for `uid` ('#rrggbb') or undefined. */
export function useNameColor(uid) {
  return useCosmetics(uid).nameColor;
}

/**
 * Convenience for lists (hooks can't run inside a map): a name span colored by the user's equipped
 * name color (falling back to `fallbackColor`), optionally followed by their badge.
 * Props: { uid, children, fallbackColor?, className?, badge = true }
 */
export function CosmeticName({ uid, children, fallbackColor, className = '', badge = true }) {
  const { nameColor } = useCosmetics(uid);
  const color = nameColor || fallbackColor;
  return (
    <>
      <span className={className} style={color ? { color } : undefined}>{children}</span>
      {badge && <CosmeticBadge uid={uid} />}
    </>
  );
}

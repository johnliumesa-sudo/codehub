// Premium perks shown next to names, on avatars and on profile cards. Each piece checks premium/{uid}
// itself (usePremiumLook), so a member who isn't premium right now shows nothing, whatever their
// upub/{uid}/premium block says. Text is rendered as React text only.
import { usePremium } from '../lib/status.js';
import { usePremiumLook } from '../lib/premium.js';
import { tagStyle } from '../lib/lookCore.js';
import '../premium.css';

export function DiamondIcon({ size = 13 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true">
      <path d="M6.5 3h11l4 6-9.5 12L2.5 9l4-6Z" fill="currentColor" fillOpacity=".25" stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round" />
      <path d="M2.5 9h19M9 3l3 18M15 3l-3 18" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round" opacity=".8" />
    </svg>
  );
}

/** Small diamond after a name while `uid` is premium. */
export function PremiumBadge({ uid, size = 13 }) {
  const { active } = usePremium(uid);
  if (!active) return null;
  return (
    <span className="pm-badge" title="Premium member" aria-label="Premium member" role="img">
      <DiamondIcon size={size} />
    </span>
  );
}

/** Custom role tag (premium only). */
export function PremiumTag({ uid }) {
  const { look } = usePremiumLook(uid);
  if (!look?.tag) return null;
  return <TagPill look={look} />;
}

export function TagPill({ look }) {
  return (
    <span className="pm-tag" style={tagStyle(look)} title={`Role tag: ${look.tag}`}>
      {look.tag}
    </span>
  );
}

/** Badge + role tag, for name rows. */
export function PremiumNameBits({ uid, size }) {
  return (
    <>
      <PremiumBadge uid={uid} size={size} />
      <PremiumTag uid={uid} />
    </>
  );
}

export function nameFxProps(look) {
  if (!look || look.nameFx === 'none') return null;
  return {
    className: `pm-name pm-name-${look.nameFx}`,
    style: { '--pm-a': look.fxA, '--pm-b': look.fxB },
    'data-fx': look.nameFx,
  };
}

/** Wraps a display name with the member's name effect (gradient, glow, shimmer, rainbow). */
export function PremiumName({ uid, children }) {
  const { look } = usePremiumLook(uid);
  const fx = nameFxProps(look);
  if (!fx) return children;
  return <span {...fx}>{children}</span>;
}

/** Wraps an avatar with the member's animated frame. `className` is added to the wrapper. */
export function PremiumAvatar({ uid, children, className = '' }) {
  const { look } = usePremiumLook(uid);
  if (!look || look.frame === 'none') return children;
  return (
    <span className={`pm-frame pm-frame-${look.frame} ${className}`} style={{ '--pm-a': look.fxA, '--pm-b': look.fxB }} data-fx={look.frame}>
      {children}
    </span>
  );
}

/**
 * Profile-card banner. Without a premium banner it renders the standard one (`className`, `style`).
 * Styles: aurora, animated gradient, starfield, or the standard banner with an animated frame.
 */
export function PremiumBanner({ uid, className, style }) {
  const { look } = usePremiumLook(uid);
  if (!look || look.banner === 'none') return <div className={className} style={style} />;
  const vars = { '--pm-a': look.fxA, '--pm-b': look.fxB };
  if (look.banner === 'frame') {
    return <div className={`${className} pm-banner pm-banner-frame`} style={{ ...style, ...vars }} data-fx="frame" />;
  }
  return (
    <div className={`${className} pm-banner pm-banner-${look.banner}`} style={vars} data-fx={look.banner}>
      {look.banner === 'starfield' && <span className="pm-stars" aria-hidden="true" />}
    </div>
  );
}

const PARTICLES = 14;

/** Sparkles / snow / confetti over a profile card (decorative; hidden with reduced motion). */
export function PremiumCardFx({ uid }) {
  const { look } = usePremiumLook(uid);
  if (!look || look.cardFx === 'none') return null;
  return (
    <span className={`pm-cardfx pm-cardfx-${look.cardFx}`} style={{ '--pm-a': look.fxA, '--pm-b': look.fxB }} data-fx={look.cardFx} aria-hidden="true">
      {Array.from({ length: PARTICLES }, (_, i) => (
        <span key={i} className="pm-p" style={{ '--i': i, left: `${(i * 37) % 100}%`, animationDelay: `${-((i * 0.73) % 5).toFixed(2)}s` }} />
      ))}
    </span>
  );
}

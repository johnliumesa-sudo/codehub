// Wallet primitives shared by the shop, the Settings → Shop items tab, the catalog editor and the item form.
import { useEffect, useState } from 'react';
import { DAILY_COINS, claimDaily, formatCountdown, msUntilClaim, serverNow, useWallet } from '../../lib/shop.js';
import { useToast } from '../layout/ui.jsx';
import './shop.css';

const errText = (e) => String(e?.message || e).replace(/^Error:\s*/, '');

export function Coin({ size = 14 }) {
  return <span className="shop-coin" style={{ width: size, height: size }} aria-hidden="true" />;
}

export function Price({ price }) {
  if (price === 0) return <span className="shop-price free">Free</span>;
  return (
    <span className="shop-price">
      <Coin size={13} />
      {price.toLocaleString()}
    </span>
  );
}

/** Re-renders every `ms` while `active`; returns the server-corrected clock. */
function useServerClock(active, ms = 1000) {
  const [now, setNow] = useState(() => serverNow());
  useEffect(() => {
    if (!active) return undefined;
    setNow(serverNow());
    const t = setInterval(() => setNow(serverNow()), ms);
    return () => clearInterval(t);
  }, [active, ms]);
  return now;
}

/** Wallet balance + daily claim with countdown. Props: { uid, compact? } */
export function WalletBar({ uid, compact = false }) {
  const toast = useToast();
  const { wallet, loading } = useWallet(uid);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const pending = wallet ? msUntilClaim(wallet) > 0 : false;
  const now = useServerClock(pending);
  const wait = wallet ? msUntilClaim(wallet, now) : 0;

  const claim = async () => {
    setBusy(true);
    setError('');
    try {
      const bal = await claimDaily(uid);
      toast(`+${DAILY_COINS} coins. Balance: ${bal.toLocaleString()}`, 'success');
    } catch (e) {
      setError(errText(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className={`shop-wallet ${compact ? 'compact' : ''}`}>
      <div className="shop-wallet-balance" aria-live="polite">
        <Coin size={compact ? 16 : 20} />
        <strong>{loading ? '…' : (wallet?.balance ?? 0).toLocaleString()}</strong>
        <span className="muted">coins</span>
      </div>
      <div className="shop-wallet-claim">
        <button className="btn primary sm" onClick={claim} disabled={busy || loading || wait > 0}>
          {busy ? <span className="spinner shop-spinner-sm" /> : wait > 0 ? <>Next claim in {formatCountdown(wait)}</> : wallet ? `Claim daily coins (+${DAILY_COINS})` : `Claim ${DAILY_COINS} starter coins`}
        </button>
        {error && <span className="error-text shop-wallet-error">{error}</span>}
      </div>
    </div>
  );
}

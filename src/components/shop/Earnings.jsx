// Shop → Earnings: coins buyers paid for my items, waiting to be collected. Each sale is collected with ONE
// update that adds exactly its price to my balance and deletes it (the rules check both); "Collect all"
// runs those one after another.
import { useState } from 'react';
import { collectAll, collectEarning, useEarnings, useSalesHistory } from '../../lib/shop.js';
import { useProfiles } from '../../lib/profiles.js';
import { useToast } from '../layout/ui.jsx';
import { Coin, Price } from './Wallet.jsx';
import './shop.css';

const errText = (e) => String(e?.message || e).replace(/^Error:\s*/, '');

function when(ts) {
  if (!ts) return '';
  const d = new Date(ts);
  const sameDay = d.toDateString() === new Date().toDateString();
  return sameDay ? d.toLocaleTimeString(undefined, { timeStyle: 'short' }) : d.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
}

/** Props: { me: {uid}, byId: {itemId: item} (catalog), wallet: wallet | null } */
export default function Earnings({ me, byId, wallet }) {
  const uid = me?.uid;
  const toast = useToast();
  const { entries, total, loading, error } = useEarnings(uid);
  const history = useSalesHistory(uid);
  const buyers = useProfiles(entries.map((e) => e.buyer));
  const [busy, setBusy] = useState(null); // entry key | 'all' | null
  const [progress, setProgress] = useState(null); // { done, of } while collecting all

  const one = async (e) => {
    setBusy(e.key);
    try {
      const coins = await collectEarning(uid, e.key);
      toast(coins ? `+${coins.toLocaleString()} coins collected` : 'Already collected', 'success');
    } catch (err) {
      toast(errText(err), 'error');
    } finally {
      setBusy(null);
    }
  };

  const all = async () => {
    setBusy('all');
    setProgress({ done: 0, of: entries.length });
    try {
      const r = await collectAll(uid, entries.map((e) => e.key), (done, of) => setProgress({ done, of }));
      toast(`+${r.coins.toLocaleString()} coins from ${r.collected} sale${r.collected === 1 ? '' : 's'}`, 'success');
    } catch (err) {
      toast(errText(err), 'error');
    } finally {
      setBusy(null);
      setProgress(null);
    }
  };

  const noWallet = !wallet;
  return (
    <div className="shop-earn">
      <div className="shop-earn-summary">
        <div className="shop-earn-stat">
          <span className="muted">To collect</span>
          <strong aria-live="polite"><Coin size={18} /> {total.toLocaleString()}</strong>
          <span className="muted">{entries.length} sale{entries.length === 1 ? '' : 's'}</span>
        </div>
        <div className="shop-earn-stat">
          <span className="muted">Collected so far</span>
          <strong><Coin size={18} /> {history.total.toLocaleString()}</strong>
          <span className="muted">{history.count} sale{history.count === 1 ? '' : 's'}</span>
        </div>
        <div className="shop-earn-cta">
          <button type="button" className="btn primary" onClick={all} disabled={!!busy || entries.length === 0 || noWallet}>
            {busy === 'all' ? (
              <>
                <span className="spinner shop-spinner-sm" /> {progress ? `${progress.done} / ${progress.of}` : ''}
              </>
            ) : (
              'Collect all'
            )}
          </button>
        </div>
      </div>
      {noWallet && entries.length > 0 && (
        <p className="shop-earn-note" role="note">Claim your starter coins (top right) to open a wallet, then collect your earnings.</p>
      )}

      {loading ? (
        <div className="shop-empty small"><span className="spinner" /></div>
      ) : error ? (
        <p className="error-text">{errText(error)}</p>
      ) : entries.length === 0 ? (
        <div className="shop-empty small">
          <h3>Nothing to collect</h3>
          <p className="muted">When someone buys one of your items, the coins they paid show up here.</p>
        </div>
      ) : (
        <ul className="shop-earn-list" aria-label="Sales to collect">
          {entries.map((e) => {
            const item = byId[e.itemId];
            const buyer = buyers[e.buyer]?.name || 'a member';
            return (
              <li key={e.key} className="shop-earn-row">
                <div className="shop-earn-info">
                  <strong>{item ? item.name : 'Deleted item'}</strong>
                  <span className="muted">
                    bought by {buyer}
                    {e.ts ? ` · ${when(e.ts)}` : ''}
                  </span>
                </div>
                <Price price={e.price} />
                <button
                  type="button"
                  className="btn sm"
                  onClick={() => one(e)}
                  disabled={!!busy || noWallet}
                  aria-label={`Collect ${e.price} coins for ${item ? item.name : 'a deleted item'} bought by ${buyer}`}
                >
                  {busy === e.key ? <span className="spinner shop-spinner-sm" /> : 'Collect'}
                </button>
              </li>
            );
          })}
        </ul>
      )}
      <p className="muted shop-footnote">
        Earnings are the exact coins buyers paid, recorded in the same update as their purchase, so they can't be created
        twice. Buying your own item earns nothing. Earnings are private to you; they are not end-to-end encrypted.
      </p>
    </div>
  );
}

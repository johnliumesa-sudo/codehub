// Renders channels grouped under collapsible categories. Row rendering stays with the caller.
import { useMemo, useState } from 'react';
import { groupByCategory, loadCollapsed, saveCollapsed } from '../../lib/serverx/categories.js';
import { Icon } from '../layout/ui.jsx';
import './serverx.css';

/**
 * Props: { sid, channels (useChannels, each with optional `cat`), categories (useCategories),
 *          renderChannel(channel) -> node, onManage? (opens CategoryManager; shown as a gear) }
 */
export function CategorizedChannels({ sid, channels, categories, renderChannel, onManage }) {
  const [collapsed, setCollapsed] = useState(loadCollapsed);
  const groups = useMemo(() => groupByCategory(channels, categories), [channels, categories]);
  const toggle = (id) =>
    setCollapsed((c) => {
      const key = `${sid}/${id}`;
      const next = { ...c, [key]: !c[key] };
      if (!next[key]) delete next[key];
      saveCollapsed(next);
      return next;
    });
  return (
    <>
      {groups.map((g) => {
        if (g.id === null) return <div key="loose">{g.channels.map(renderChannel)}</div>;
        const shut = !!collapsed[`${sid}/${g.id}`];
        return (
          <div key={g.id} className="sx-cat">
            <div className="sx-cat-head">
              <button className="sx-cat-toggle" onClick={() => toggle(g.id)} aria-expanded={!shut}>
                <Icon name="chevron" size={12} className={shut ? 'sx-chev shut' : 'sx-chev'} />
                <span>{g.name}</span>
              </button>
              {onManage && (
                <button className="sx-cat-gear" onClick={onManage} aria-label="Manage categories" title="Manage categories">
                  <Icon name="gear" size={12} />
                </button>
              )}
            </div>
            {!shut && g.channels.map(renderChannel)}
          </div>
        );
      })}
    </>
  );
}

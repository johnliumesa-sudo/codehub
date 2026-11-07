// Lazy entry points: the add-on UI (directory, builder, runner, settings) loads as its own chunk the
// first time it is shown, so the app's start-up bundle only carries the registrations.
import { Suspense, lazy } from 'react';

const pick = (load, name) => lazy(() => load().then((m) => ({ default: m[name] })));
const panels = () => import('./AddonsPanel.jsx');
const admin = () => import('./AdminReport.jsx');

const COMPONENTS = {
  AddonsPanel: pick(panels, 'AddonsPanel'),
  ServerAddonPanel: pick(panels, 'ServerAddonPanel'),
  Hub: lazy(() => import('./Hub.jsx')),
  UserAddonsTab: lazy(() => import('./UserAddonsTab.jsx')),
  ServerAddonsTab: lazy(() => import('./ServerAddonsTab.jsx')),
  AdminAddonsTab: lazy(() => import('./AdminAddonsTab.jsx')),
  ReportedAddon: pick(admin, 'ReportedAddon'),
  RemoveReportedAddon: pick(admin, 'RemoveReportedAddon'),
};

const Spinner = () => (
  <div className="ad-center"><div className="spinner" aria-label="Loading" /></div>
);

/** <Lazy name="Hub" ...props />; `inline` uses a text fallback (for small inline slots). */
export function Lazy({ name, inline = false, ...props }) {
  const C = COMPONENTS[name];
  return (
    <Suspense fallback={inline ? <span className="muted">…</span> : <Spinner />}>
      <C {...props} />
    </Suspense>
  );
}

// Add-on reports through the existing reports flow (reports/{rid} + reportLog): kind `addon`, target =
// the pub/addons id. Reports filed before the `addon` kind existed used kind `shopItem` with target
// `addon:{id}`; the admin reports queue still recognizes those (reportTargets registry).
export const ADDON_REPORT_KIND = 'addon';
export const addonReportTarget = (id) => String(id);
const ID = /^[A-Za-z0-9_-]{1,64}$/;
/** The add-on id of a report target `addon:{id}` (legacy shopItem reports), else null. */
export const addonIdFromTarget = (t) => (typeof t === 'string' && /^addon:[A-Za-z0-9_-]{1,64}$/.test(t) ? t.slice(6) : null);
/** The add-on a report is about (kind `addon`, or a legacy `shopItem` report with `addon:{id}`), else null. */
export function reportedAddonId(r) {
  if (r?.kind === 'addon') return typeof r.target === 'string' && ID.test(r.target) ? r.target : null;
  if (r?.kind === 'shopItem') return addonIdFromTarget(r.target);
  return null;
}

// Add-on reports through the existing reports flow (reports/{rid} + reportLog). The reports rules
// accept a fixed list of kinds (game, user, shopItem, message) and this workstream's rule budget is
// zero bytes, so an add-on report is filed as kind `shopItem` (a public catalog item) with target
// `addon:{id}`; the admin reports queue recognizes the prefix through the `reportTargets` registry.
export const ADDON_REPORT_KIND = 'shopItem';
export const addonReportTarget = (id) => `addon:${id}`;
/** The add-on id of a report target `addon:{id}`, else null. */
export const addonIdFromTarget = (t) => (typeof t === 'string' && /^addon:[A-Za-z0-9_-]{1,64}$/.test(t) ? t.slice(6) : null);

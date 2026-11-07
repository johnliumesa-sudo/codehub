// Premium membership (monthly codes, owner dashboard, perks) and the agentic coding mode.
// Registers UI through the extension registries (src/lib/ext/registry.js). See docs/features/premium.md.
//   userSettingsTabs  premium        Settings → Premium: redeem / renew, status, premium look
//   adminTabs         owner          Admin panel → Owner: passcode-locked codes, members, database rules
//   messageBadges     premium.badge  diamond + custom role tag after the author name
//   paletteActions    premium.open   "Open Premium settings"
// Small edits in core files: Message, MemberList (rows + profile card), UserPanel, GroupMembersPanel
// (badge, name effect, avatar frame, banner, card effect), the shop (double coins, premium-only items)
// and account deletion (premium/{uid}).
import { createElement as h } from 'react';
import { register } from '../../lib/ext/registry.js';
import PremiumSettings from './components/PremiumSettings.jsx';
import OwnerTab from './components/OwnerTab.jsx';
import { PremiumNameBits } from './components/PremiumBits.jsx';
import './agent/index.js';

register('userSettingsTabs', { id: 'premium', label: 'Premium', render: (ctx) => h(PremiumSettings, { ctx }) });

register('adminTabs', { id: 'owner', label: 'Owner', render: () => h(OwnerTab) });

register('messageBadges', { id: 'premium.badge', render: (m) => (m?.uid ? h(PremiumNameBits, { uid: m.uid }) : null) });

register('paletteActions', {
  id: 'premium.open',
  title: 'Open Premium settings',
  keywords: ['premium', 'membership', 'redeem', 'code', 'perks'],
  run: (ctx) => ctx.openSettings('premium'),
});

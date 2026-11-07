// Round 3 feature workstreams. Each folder registers its UI and send hooks through the extension
// registries (src/lib/ext/registry.js) from its own index.js; see ARCHITECTURE.md "Round 3:
// extension points". Imported once at app start (src/main.jsx); this file never needs editing.
import '../lib/ext/core.js';
import './bots/index.js';
import './addons/index.js';
import './assistant/index.js';
import './calls/index.js';
import './messaging/index.js';
import './personal/index.js';
import './community/index.js';

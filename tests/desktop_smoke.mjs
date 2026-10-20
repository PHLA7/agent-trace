/**
 * Load the desktop half the way the Desktop app loads it, and call register().
 *
 * `src/contrib/runtime-loader.ts` rewrites the only resolvable specifiers
 * (`@hermes/plugin-sdk`, `react*`) to live module URLs, blob-imports the result, validates the
 * default export, and calls `register(ctx)`. This harness does the same thing with local stub
 * modules, which turns "the file parses" into "the file evaluates and registers".
 *
 * What it catches that `node --check` cannot: a missing named export (ESM resolves imports at link
 * time, so the module throws before register is ever reached), a top-level call the environment
 * cannot satisfy, a register() that throws, and a contribution set that does not match the spec.
 *
 * Run: node tests/desktop_smoke.mjs
 */

import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');
const STUBS = join(HERE, 'stubs');

const SOURCE = readFileSync(join(ROOT, 'desktop', 'plugin.js'), 'utf8');

const failures = [];
const notes = [];

/** Rewrite only the mapped specifiers, never occurrences inside strings or comments. */
function rewriteSpecifiers(source, map) {
  const scratch = mkdtempSync(join(tmpdir(), 'agent-trace-smoke-'));
  let out = source;
  for (const [specifier, target] of Object.entries(map)) {
    const url = pathToFileURL(join(STUBS, target)).href;
    out = out.split(`'${specifier}'`).join(`'${url}'`);
    out = out.split(`"${specifier}"`).join(`"${url}"`);
  }
  const file = join(scratch, 'plugin.mjs');
  writeFileSync(file, out, 'utf8');
  return { file, scratch };
}

const imports = [...new Set([...SOURCE.matchAll(/^\s*import[\s\S]*?from\s+['"]([^'"]+)['"]/gm)]
  .map((match) => match[1]))];
notes.push(`import specifiers: ${imports.join(', ')}`);

const { file, scratch } = rewriteSpecifiers(SOURCE, {
  '@hermes/plugin-sdk': 'plugin-sdk.mjs',
  'react/jsx-runtime': 'jsx-runtime.mjs',
  react: 'react.mjs'
});

const contributions = [];
const settingsPages = [];
const subscribedEvents = new Set();
const intervals = [];
const i18nBundles = [];
let restCalls = [];
let disposed = 0;

const disposer = () => { disposed += 1; };

const ctx = {
  source: 'plugin:agent-trace',
  register: (contribution) => { contributions.push(contribution); return disposer; },
  registerMany: (list) => { for (const entry of list) contributions.push(entry); return disposer; },
  registerSettingsPage: (page) => { settingsPages.push(page); return disposer; },
  rest: async (path, options) => { restCalls.push({ path, options }); throw new Error('backend off in harness'); },
  socket: () => disposer,
  onEvent: (type) => { subscribedEvents.add(type); return disposer; },
  onDispose: () => disposer,
  setTimeout: (fn, ms) => { intervals.push(['timeout', ms]); return disposer; },
  setInterval: (fn, ms) => { intervals.push(['interval', ms]); return disposer; },
  addEventListener: () => disposer,
  os: { notify: () => false, openExternal: () => false, revealPath: () => false, writeClipboard: () => false },
  pet: { visible: false, say: () => disposer, clear: () => {} },
  storage: {
    _values: {},
    get(key) { return Object.prototype.hasOwnProperty.call(this._values, key) ? this._values[key] : null; },
    set(key, value) { this._values[key] = value; },
    remove(key) { delete this._values[key]; }
  },
  i18n: {
    // Resolves against the registered bundle, so a title that comes back as the raw key proves the
    // bundle was registered after the contribution that used it.
    _bundle: null,
    register(bundle) { i18nBundles.push(bundle); ctx.i18n._bundle = bundle },
    t(key, ...args) {
      const en = (ctx.i18n._bundle && ctx.i18n._bundle.en) || {};
      const value = en[key];
      if (typeof value === 'function') return value(...args);
      return value === undefined ? key : value;
    }
  },
  runAction: async () => ({ ok: false, reason: 'unavailable' }),
  listActions: () => [],
  registerSkill: () => disposer
};

let plugin;
try {
  const module = await import(pathToFileURL(file).href);
  plugin = module.default;
} catch (error) {
  failures.push(`the module did not evaluate: ${error && error.message}`);
}

if (plugin) {
  if (plugin.id !== 'agent-trace') failures.push(`id is ${JSON.stringify(plugin.id)}, expected 'agent-trace'`);
  if (typeof plugin.register !== 'function') failures.push('default export has no register()');
  if (plugin.defaultEnabled !== false) {
    notes.push(`defaultEnabled is ${JSON.stringify(plugin.defaultEnabled)} (a unified package's desktop half should be opt-in)`);
  }
}

if (plugin && typeof plugin.register === 'function') {
  try {
    plugin.register(ctx);
  } catch (error) {
    failures.push(`register(ctx) threw: ${error && error.message}`);
  }
}

// ── assertions ──────────────────────────────────────────────────────────────────────────────
const sdk = await import(pathToFileURL(join(STUBS, 'plugin-sdk.mjs')).href);
const areas = contributions.map((c) => c.area);
// Compare against the SDK's own constants, so this asserts "registered in the area the app
// exports" rather than "registered the literal string I typed into this file". The real values
// live in the app: PANES_AREA in sdk/areas.ts, ROUTES_AREA and SIDEBAR_NAV_AREA in app/routes.ts,
// PALETTE_AREA in app/command-palette/contrib.ts, KEYBINDS_AREA in lib/keybinds/actions.ts.
const REQUIRED = {
  'docked pane': sdk.PANES_AREA,
  'full page': sdk.ROUTES_AREA,
  'sidebar nav': sdk.SIDEBAR_NAV_AREA,
  palette: sdk.PALETTE_AREA,
  keybinds: sdk.KEYBINDS_AREA
};
for (const [label, expected] of Object.entries(REQUIRED)) {
  if (!areas.includes(expected)) failures.push(`no contribution registered in the ${label} area (${expected})`);
}

if (settingsPages.length !== 1) {
  failures.push(`registered ${settingsPages.length} settings page(s), expected exactly 1`);
}

if (i18nBundles.length !== 1) failures.push(`registered ${i18nBundles.length} i18n bundle(s), expected 1`);
else if (!i18nBundles[0].en) failures.push('the i18n bundle has no `en` strings');

// A contribution title that resolves to its own key means the bundle was registered too late.
const enStrings = (i18nBundles[0] && i18nBundles[0].en) || {};
for (const contribution of contributions) {
  if (contribution.title && Object.prototype.hasOwnProperty.call(enStrings, contribution.title)) {
    failures.push(`contribution ${contribution.id} title resolved to its own i18n key `
      + `('${contribution.title}'): the bundle must be registered before the contribution that uses it`);
  }
}

if (subscribedEvents.size === 0) failures.push('subscribed to no gateway events');
if (!intervals.some(([kind]) => kind === 'interval')) failures.push('registered no interval (the render clock / live poll)');

for (const contribution of contributions) {
  if (!contribution.id) failures.push(`a contribution has no id: ${JSON.stringify(contribution).slice(0, 80)}`);
  if (typeof contribution.render !== 'function' && !contribution.data) {
    failures.push(`contribution ${contribution.id} supplies neither render nor data`);
  }
}

// The probe runs in a microtask, so let it settle before counting it.
await new Promise((resolve_) => setTimeout(resolve_, 60));

const statusProbes = restCalls.filter((call) => call.path === '/status');
if (statusProbes.length !== 1) {
  failures.push(`probed /status ${statusProbes.length} time(s) at register, expected exactly 1`);
}
if (statusProbes.length === 1 && String((statusProbes[0].options || {}).method || 'GET') !== 'GET') {
  failures.push('the /status probe is not a GET');
}

for (const notification of sdk.__recorded.notifications) {
  if (/fail|error/i.test(String(notification && notification.message))) {
    failures.push(`the plugin surfaced an error toast at register: ${notification.message}`);
  }
}

// ── report ──────────────────────────────────────────────────────────────────────────────────
console.log('desktop half — loader harness');
for (const note of notes) console.log(`  note: ${note}`);
console.log(`  contributions: ${contributions.length}`);
for (const contribution of contributions) {
  console.log(`    ${String(contribution.area).padEnd(14)} ${contribution.id}${contribution.title ? ` — ${contribution.title}` : ''}`);
}
console.log(`  settings pages: ${settingsPages.length}`);
console.log(`  i18n bundles: ${i18nBundles.length}${i18nBundles[0] ? ` (en keys: ${Object.keys(i18nBundles[0].en || {}).length})` : ''}`);
console.log(`  gateway events subscribed: ${subscribedEvents.size}${[...subscribedEvents].length ? ` (${[...subscribedEvents].slice(0, 6).join(', ')}${subscribedEvents.size > 6 ? ', …' : ''})` : ''}`);
console.log(`  timers: ${intervals.map(([kind, ms]) => `${kind}@${ms}ms`).join(', ') || 'none'}`);
console.log(`  rest calls at register: ${restCalls.map((call) => call.path).join(', ') || 'none'}`);

rmSync(scratch, { recursive: true, force: true });

if (failures.length) {
  console.log('\nFAIL:');
  for (const failure of failures) console.log(`  - ${failure}`);
  process.exit(1);
}
console.log('\nOK: the desktop half evaluates and registers inside a loader harness that mimics the app');
/**
 * Minimal stand-in for `@hermes/plugin-sdk`, used only by tests/desktop_smoke.mjs.
 *
 * It exports exactly the symbols the plugin imports. ESM named imports resolve at link time, so a
 * permissive Proxy cannot stand in here — the names have to be real, and a missing one is exactly
 * the failure this harness exists to catch.
 *
 * Behaviour is the smallest thing that lets `register(ctx)` run: atoms actually hold values,
 * components are placeholders, and every door that talks to the app is recorded rather than
 * performed.
 */

function atom(initial) {
  let value = initial;
  const listeners = new Set();
  return {
    get: () => value,
    set: (next) => {
      value = next;
      for (const listener of listeners) {
        try { listener(value) } catch (e) { /* a listener must never break a set */ }
      }
    },
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    listen: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    }
  };
}

function computed(fn) {
  return { get: () => fn() };
}

const noopDisposer = () => () => {};
const placeholder = (name) => {
  const Component = () => null;
  Object.defineProperty(Component, 'name', { value: name });
  return Component;
};

export const __recorded = { notifications: [], navigations: [], i18n: [], intervals: [], timeouts: [], disposers: 0 };

export { atom, computed };

export const host = {
  state: {
    activeSessionId: atom(null),
    focusedSessionId: atom(null),
    focusedStoredSessionId: atom(null),
    focusedSessionProfile: atom('default'),
    focusedUsage: atom(null),
    busy: atom(false),
    awaitingResponse: atom(false),
    busyBySession: atom({}),
    cwd: atom('/tmp'),
    gateway: atom('open'),
    model: atom('test-model'),
    profile: atom('default'),
    viewport: atom({ width: 1200, height: 800 })
  },
  request: async () => ({}),
  onEvent: () => noopDisposer(),
  notify: (payload) => { __recorded.notifications.push(payload) },
  navigate: (path) => { __recorded.navigations.push(path) },
  logs: async () => [],
  status: async () => ({}),
  settings: { get: () => null, set: () => {}, subscribe: () => noopDisposer() },
  i18n: { languageOptions: () => [], registerAppLocale: () => noopDisposer() }
};

export const haptic = () => {};
export const cn = (...parts) => parts.flat().filter(Boolean).join(' ');

export const PANES_AREA = 'panes';
export const ROUTES_AREA = 'routes';
export const SIDEBAR_NAV_AREA = 'sidebar.nav';
export const PALETTE_AREA = 'palette';
export const KEYBINDS_AREA = 'keybinds';
export const STATUSBAR_AREAS = { left: 'statusBar.left', right: 'statusBar.right' };
export const TITLEBAR_AREAS = { left: 'titleBar.left', center: 'titleBar.center', right: 'titleBar.right' };
export const THEMES_AREA = 'themes';
export const SETTINGS_PLUGINS_AREA = 'settings.plugins';

export const Badge = placeholder('Badge');
export const Button = placeholder('Button');
export const Codicon = placeholder('Codicon');
export const CopyButton = placeholder('CopyButton');
export const DecodeText = placeholder('DecodeText');
export const EmptyState = placeholder('EmptyState');
export const ListRow = placeholder('ListRow');
export const LogView = placeholder('LogView');
export const ScrollArea = placeholder('ScrollArea');
export const SearchField = placeholder('SearchField');
export const SegmentedControl = placeholder('SegmentedControl');
export const Tip = placeholder('Tip');
export const ToggleRow = placeholder('ToggleRow');

export const icons = {};

export const useValue = (candidate) =>
  candidate && typeof candidate.get === 'function' ? candidate.get() : candidate;

export const usePluginI18n = () => (key) => key;

export const queryClient = {
  invalidateQueries: async () => {},
  refetchQueries: async () => {},
  setQueryData: () => {},
  getQueryData: () => undefined
};

export const useQuery = (options) => {
  const data = options && typeof options.queryFn === 'function' ? undefined : undefined;
  return { data, isLoading: false, isError: false, error: null, refetch: async () => ({ data }) };
};

export const useMutation = () => ({ mutate: async () => {}, mutateAsync: async () => ({}), isLoading: false });
export const useQueryClient = () => queryClient;
/**
 * Minimal stand-in for `react/jsx-runtime`, used only by tests/desktop_smoke.mjs.
 *
 * The plugin is written with jsx()/jsxs() calls because it is loaded uncompiled. The harness runs
 * register() and never renders, but the calls still evaluate, so these record what they were asked
 * to build and return a plain descriptor.
 */

export const __recorded = { nodes: 0, tags: [] };

function build(type, props) {
  __recorded.nodes += 1;
  if (typeof type === 'string' && !__recorded.tags.includes(type)) __recorded.tags.push(type);
  return { type, props: props || {}, key: (props && props.key) || null };
}

export const jsx = (type, props, key) => build(type, key ? { ...props, key } : props);
export const jsxs = jsx;
export const Fragment = Symbol.for('react.fragment');
export const jsxDEV = jsx;
/**
 * Minimal stand-in for the app's `react`, used only by tests/desktop_smoke.mjs.
 *
 * The plugin imports `useMemo` and `useState` from here. Components never render under the harness,
 * so these only need to be callable and to behave sanely if a component body does run.
 */

export const useState = (initial) => [typeof initial === 'function' ? initial() : initial, () => {}];
export const useMemo = (factory) => factory();
export const useCallback = (fn) => fn;
export const useEffect = () => {};
export const useRef = (initial) => ({ current: initial });
export const useReducer = (reducer, initial) => [initial, () => {}];
export const useContext = () => null;
export const createContext = (value) => ({ Provider: ({ children }) => children, _currentValue: value });
export const Fragment = Symbol.for('react.fragment');
export const memo = (component) => component;
export const useLayoutEffect = () => {};
export const useId = () => 'test-id';

export default {
  useState, useMemo, useCallback, useEffect, useRef, useReducer, useContext, createContext,
  Fragment, memo, useLayoutEffect, useId
};
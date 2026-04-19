/**
 * @file useAppStoreSelector.ts
 * @description Stable React hook wrapper for the Zustand app store.
 *
 * React 19's useSyncExternalStore requires getSnapshot to return the same
 * reference when the underlying data hasn't changed. Zustand 5's built-in
 * useStore creates a new useCallback closure per render, and immer always
 * produces new state objects on every set(), so selectors that return objects
 * or arrays trigger infinite re-render loops.
 *
 * This module re-exports the store with a stable hook wrapper. All components
 * should import `useAppStore` from THIS module instead of directly from
 * useAppStore.ts.
 */
import { useCallback, useRef, useSyncExternalStore } from "react";
import { useAppStore as _rawStore } from "./useAppStore";
import type { AppStore } from "./appStore.types";
type StoreApi = typeof _rawStore;
function _shallowEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a == null || b == null) return false;
  if (typeof a !== "object" || typeof b !== "object") return false;
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) {
      if (a[i] !== b[i]) return false;
    }
    return true;
  }
  const keysA = Object.keys(a as Record<string, unknown>);
  const keysB = Object.keys(b as Record<string, unknown>);
  if (keysA.length !== keysB.length) return false;
  for (const key of keysA) {
    if ((a as Record<string, unknown>)[key] !== (b as Record<string, unknown>)[key]) {
      return false;
    }
  }
  return true;
}
interface StableUseAppStore {
  <T>(selector?: (s: AppStore) => T): T;
  (): AppStore;
  getState: StoreApi["getState"];
  setState: StoreApi["setState"];
  subscribe: StoreApi["subscribe"];
  getInitialState: StoreApi["getInitialState"];
}
function _hookImpl<T>(selector?: (s: AppStore) => T): T {
  const selectorRef = useRef(selector);
  selectorRef.current = selector;
  const cachedRef = useRef<{ value: T; state: AppStore } | null>(null);
  const getSnapshot = useCallback(() => {
    const state = _rawStore.getState();
    const cached = cachedRef.current;
    if (cached && cached.state === state) return cached.value;
    const newValue = selectorRef.current
      ? selectorRef.current(state)
      : (state as unknown as T);
    if (cached && _shallowEqual(cached.value, newValue)) {
      cached.state = state;
      return cached.value;
    }
    cachedRef.current = { value: newValue, state };
    return newValue;
  }, []);
  const subscribe = useCallback(
    (onStoreChange: () => void) => _rawStore.subscribe(onStoreChange),
    []
  );
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}
export const useAppStore: StableUseAppStore = _hookImpl as unknown as StableUseAppStore;
useAppStore.getState = _rawStore.getState;
useAppStore.setState = _rawStore.setState;
useAppStore.subscribe = _rawStore.subscribe;
useAppStore.getInitialState = _rawStore.getInitialState;

/**
 * @file stable.ts
 * @description Selector stability utilities for React 19 compatibility.
 *
 * React 19's useSyncExternalStore requires selectors to return the same
 * reference when state hasn't meaningfully changed. If a selector returns
 * a new object literal or array on every call, React detects reference
 * inequality and triggers an infinite re-render loop.
 *
 * This module provides `stableSelector`, which wraps a selector with
 * shallow-equality caching to guarantee stable references.
 */

// ============================================================================
// Internal: Shallow Equality
// ============================================================================

/**
 * Compare two objects by own-property values (one level deep).
 * Arrays are compared element-by-element via ===.
 * Sufficient for selector return types; not a general-purpose deep equal.
 */
function shallowEqual<T extends object>(a: T, b: T): boolean {
  if (a === b) return true;

  const keysA = Object.keys(a);
  const keysB = Object.keys(b);

  if (keysA.length !== keysB.length) return false;

  for (const key of keysA) {
    if ((a as Record<string, unknown>)[key] !== (b as Record<string, unknown>)[key]) {
      return false;
    }
  }

  return true;
}

/**
 * Compare two arrays element-by-element with strict equality.
 * This is sufficient for selector outputs that are already composed of
 * normalized entity references.
 */
function shallowEqualArray<T>(a: readonly T[], b: readonly T[]): boolean {
  if (a === b) return true;
  if (a.length !== b.length) return false;

  for (let index = 0; index < a.length; index += 1) {
    if (a[index] !== b[index]) {
      return false;
    }
  }

  return true;
}

// ============================================================================
// Public API
// ============================================================================

/**
 * Wrap a selector to return stable references via shallow-equality caching.
 *
 * How it works:
 *   1. On each call, compute the new result via the inner selector.
 *   2. If the new result is shallowly equal to the cached result, return
 *      the cached reference (same identity → React is happy).
 *   3. Otherwise, update the cache and return the new result.
 *
 * The `defaultValue` is used as the initial cache and should be a frozen
 * constant (Object.freeze) so that the very first render returns a stable
 * reference.
 *
 * @param selector  - The raw selector that may return new objects each call
 * @param defaultValue - A frozen constant for the "empty" case
 * @returns A selector guaranteed to return stable references
 *
 * @example
 * ```ts
 * const EMPTY: MyResult = Object.freeze({ items: [], count: 0 });
 *
 * const selectMyData = stableSelector(
 *   (state: AppStore) => ({
 *     items: state.items.filter(x => x.active),
 *     count: state.items.length,
 *   }),
 *   EMPTY,
 * );
 * ```
 */
export function stableSelector<S, T extends object>(
  selector: (state: S) => T,
  defaultValue: T
): (state: S) => T {
  let lastState: S | null = null;
  let cached: T = defaultValue;

  return (state: S): T => {
    // Fast path: same state reference → same result
    if (state === lastState) return cached;

    lastState = state;
    const result = selector(state);

    if (shallowEqual(result, cached)) {
      return cached;
    }

    cached = result;
    return result;
  };
}

/**
 * Wrap an array selector so React 19 receives a stable array reference.
 * This prevents `getSnapshot should be cached` errors when selectors rebuild
 * arrays from normalized entity maps on every call.
 */
export function stableArraySelector<S, T>(
  selector: (state: S) => readonly T[],
  defaultValue: readonly T[]
): (state: S) => readonly T[] {
  let lastState: S | null = null;
  let cached: readonly T[] = defaultValue;

  return (state: S): readonly T[] => {
    if (state === lastState) return cached;

    lastState = state;
    const result = selector(state);

    if (shallowEqualArray(result, cached)) {
      return cached;
    }

    cached = result;
    return result;
  };
}

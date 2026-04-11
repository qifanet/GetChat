/**
 * @file tauriApiCore.ts
 * @description Stub module for @tauri-apps/api/core.
 *
 * In the real app, Tauri provides this module at runtime.
 * In tests, this stub is resolved via vitest alias so that
 * vi.mock("@tauri-apps/api/core") can intercept the import.
 *
 * The stub export is a no-op — tests override it via vi.mock().
 */

export function invoke(..._args: unknown[]): Promise<unknown> {
  throw new Error(
    "invoke() called without a mock. " +
    "Add vi.mock('@tauri-apps/api/core') to your test file."
  );
}

/**
 * Minimal Channel stub for unit tests.
 *
 * Tests that care about Channel behavior should still provide their own mock,
 * but exporting this class keeps generic imports type-compatible.
 */
export class Channel<T = unknown> {
  id = 1;
  onmessage: (response: T) => void;

  constructor(onmessage?: (response: T) => void) {
    this.onmessage = onmessage ?? (() => undefined);
  }
}

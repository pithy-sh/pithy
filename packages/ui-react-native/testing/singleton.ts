// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

/**
 * One instance of a stand-in's state for the whole test file, kept on `globalThis`. A test that calls
 * `vi.resetModules()` to re-read `Platform.OS` re-evaluates the stand-ins too, and a test holding the controls it
 * imported before the reset must still be driving the module the template now uses.
 */
export function singleton<T>(name: string, make: () => T): T {
  const store = globalThis as unknown as Record<string, T | undefined>;
  const key = `__pithyStub:${name}`;
  store[key] ??= make();
  return store[key] as T;
}

// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

/**
 * Metro's `require.context`, answering an empty directory, so any template that reaches the router's registration
 * imports cleanly under test. A test that needs screens registered mocks `templates/src/route-modules` instead.
 */
const empty = Object.assign(
  (): never => {
    throw new Error("Nothing is registered under test. Mock templates/src/route-modules to register screens.");
  },
  { keys: (): string[] => [] },
);

Object.assign(globalThis, { require: { context: () => empty } });

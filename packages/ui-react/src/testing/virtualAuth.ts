// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

/**
 * What `virtual:pithy/auth` resolves to under vitest.
 *
 * `{ enabled: false }` and nothing else — the exact shape `@pithy-sh/vite` serves for a capability the
 * Worker does not compose. A screen under test takes its projection as a prop, so this value is never
 * the one asserted against; it exists so importing a template module does not have to resolve a module
 * that only a Vite build can produce.
 */
export default { enabled: false as const };

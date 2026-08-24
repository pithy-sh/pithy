// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

/**
 * What `virtual:pithy/i18n` resolves to under vitest.
 *
 * `{ enabled: false }` and nothing else — the exact shape `@pithy-sh/vite` serves for a capability the
 * Worker does not compose, and the shape every screen has to render correctly under, because a project
 * that never composes `i18n` is the common case.
 *
 * **Every `dom` test in this package needs it, whether or not it is about language.** They all import a
 * screen, every screen imports `src/pithy-config.tsx`, and that module imports all five virtual modules
 * to narrow them in one place. Without this alias the whole project fails to resolve, on tests that
 * have nothing to do with locale.
 */
export default { enabled: false as const };

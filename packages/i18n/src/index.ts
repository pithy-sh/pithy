// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

/**
 * The package entrypoint — the surface `pithy add i18n` wires into `pithy.config.ts`. Deliberately
 * narrow: the capability factory plus the config types an app declares.
 *
 * The React bindings are a first-class public API of this package and are imported by deep path
 * (`@pithy-sh/i18n/src/react/translator`) at the component that mounts them — the documented contract,
 * not a barrel over the package, and what keeps `react` off the Worker program's import graph. The
 * adapters (`@pithy-sh/i18n/src/adapters/*`) and the browser helpers
 * (`@pithy-sh/i18n/src/browser/signals`) are reached the same way.
 *
 * `Translator` itself lives in `@pithy-sh/core/src/i18n/translator` and is importable **without
 * composing this capability**, so an adopter's own module can type against the seam whether or not
 * they ever opt in.
 */

export { type I18nCapability, i18n, isI18nCapability } from "./capability";
export { BrowserResolver, type I18nConfig, type I18nConfigInput, ServerResolver } from "./config/config";

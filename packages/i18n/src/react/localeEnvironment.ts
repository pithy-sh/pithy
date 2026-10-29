// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import type { BrowserChain, BrowserLocaleSignals } from "../resolve/browser";

/** The two names a client looks its own signals up by. */
export type LocaleKeys = Pick<BrowserChain, "queryParam" | "storageKey">;

/**
 * Where `useNegotiatedLocale` gets its starting signals, where it remembers a choice, and how it applies the locale.
 *
 * The browser's is the default; `@pithy-sh/i18n/src/native/environment` is React Native's. Both hooks are called on
 * every render, so the environment a component passes must be the same one for the life of that component: a module
 * constant, never an object built in the render.
 */
export interface LocaleEnvironment {
  /**
   * The signals this platform holds, as a hook, so a source that changes while the app runs, or answers after the
   * first render, re-renders the caller. `undefined` while a signal is still being read: nothing is negotiated, no
   * catalog is asked for and nothing is applied until it answers. `keys` is `null` when the capability is not
   * composed, and nothing is read.
   */
  readonly useSignals: (keys: LocaleKeys | null) => BrowserLocaleSignals | undefined;
  /** Remember a choice on this device. Not awaited; a rejection is caught. */
  readonly remember: (locale: string, keys: LocaleKeys) => void | Promise<void>;
  /**
   * Apply the locale in force, as a hook. Answers `true` when the direction it applied takes effect only after the
   * app reloads, which is React Native's rule for `I18nManager`. The browser always answers `false`.
   */
  readonly useApply: (enabled: boolean, locale: string, direction: "ltr" | "rtl") => boolean;
}

// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

/**
 * **The two files a kit deploy writes beside a host's worker module, and removes when it is done** — named here,
 * in a module that imports nothing, so the test utility that has to recognize them in a package it copies
 * (`test-utils/linkKit.ts`) reads two names rather than the whole deploy path behind them (#711).
 */

/**
 * The temporary config a deploy writes beside the worker module for `env`, so wrangler's relative `main` resolves.
 */
export function hostConfigFile(env: string): string {
  return `.wrangler.${env}.json`;
}

/** The generated entry's file name for one environment, beside the config that names it. */
export function hostEntryFile(env: string): string {
  return `.pithy-host.${env}.ts`;
}

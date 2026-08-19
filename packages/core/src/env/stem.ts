// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

/**
 * How a member of the dev set publishes its address, and how a sibling looks it up.
 *
 * `pithy dev` pins one port per worker at feature-create and exports `<STEM>_PORT` / `<STEM>_ORIGIN`
 * for every one of them, so a worker reaches its peers at a known address rather than through
 * wrangler's cross-`wrangler dev` service registry (CLAUDE.md §CLI). The stem is the join: the CLI
 * writes the var, and code running *inside* the Worker reads it.
 *
 * **It lives in core because both ends are now real.** It was the CLI's private helper while only the
 * CLI used it; the loopback Workflow dispatcher ({@link ../workflow/loopback.ts}) made the runtime the
 * other end of the same wire, and two copies of a name-derivation rule are two answers the first day
 * one of them learns about a character the other does not.
 */

/**
 * The env-var stem for a worker or capability: uppercased, every non-alphanumeric run collapsed to a
 * single `_`, leading and trailing separators dropped. `media-cli` → `MEDIA_CLI`.
 *
 * Deterministic, so the name a worker publishes is the name every sibling looks up.
 */
export function envStem(name: string): string {
  return name
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

/** The var carrying one member's loopback address — `email` → `EMAIL_ORIGIN`. */
export function originVarName(name: string): string {
  return `${envStem(name)}_ORIGIN`;
}

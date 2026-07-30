// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

/**
 * The canonical example identities — a small, fixed cast of demo users that every capability's
 * example seed set references. It is what makes `pithy seed` (with `seed.includeExamples`) fill a
 * fresh backend with *connected* data instead of isolated rows: the same three users own the seeded
 * auth records, leaderboard scores, ledger balances, and multiplayer results, so a new project can
 * see the whole stack working together in `dev` without authoring a fixture first.
 *
 * This is the shared vocabulary that lets each capability seed user-linked rows without depending on
 * `@pithy-sh/auth` — or on each other. Every module reads these ids from `@pithy-sh/core`, the one
 * seam they all share (capabilities depend on core seams, never each other's internals). It is a
 * seeding *convention*, the peer of the standard asset-metadata block: a handful of stable
 * constants, never a data set.
 *
 * The ids are stable and human-legible (`example-<name>`) so seeded rows are obvious in a dev
 * database. Emails use the reserved `example.com` domain (RFC 2606) so a seeded user can never
 * collide with, or be mistaken for, a real address.
 */

/** One canonical demo user — the shared identity a capability's example seed hangs its rows off. */
export interface ExampleIdentity {
  /** The stable demo user id — used as the `userId`/owner across every capability's example seed. */
  id: string;
  /** The user's display name. */
  name: string;
  /** The user's unique email, on the reserved `example.com` domain. */
  email: string;
}

/**
 * The canonical demo cast, in a stable order. Referenced by every capability's example seed set so
 * the seeded data is connected across tables. Keep it tiny — this is a demonstration, not a dataset.
 */
export const EXAMPLE_IDENTITIES = [
  { id: "example-ada", name: "Ada Lovelace", email: "ada@example.com" },
  { id: "example-grace", name: "Grace Hopper", email: "grace@example.com" },
  { id: "example-alan", name: "Alan Turing", email: "alan@example.com" },
] as const satisfies readonly ExampleIdentity[];

/** The three canonical identities by name, for readable references in fixtures (`EXAMPLE_ADA.id`). */
export const [EXAMPLE_ADA, EXAMPLE_GRACE, EXAMPLE_ALAN] = EXAMPLE_IDENTITIES;

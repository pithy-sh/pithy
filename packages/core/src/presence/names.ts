// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { z } from "zod";

/**
 * The three names a presence room is made of, as Zod schemas and nothing else.
 *
 * A leaf on purpose: the manifest's room descriptor, the ticket responses and the frames all read these, and
 * a management client holds those in a browser. So this module imports zod and no other thing — never the
 * declaration, which names the Hono context a session gate runs in.
 */

/** A room kind's name: the declaring capability's name, a dot, and a noun — `support.thread`. */
export const PresenceRoomKindName = z
  .string()
  .regex(
    /^[a-z][a-z0-9]*(?:\.[a-z][a-z0-9_]*)+$/,
    "A room kind is the capability's name, a dot, and a lowercase noun — `support.thread`.",
  )
  .max(64)
  .describe(
    "A room kind: the declaring capability's name, a dot, and a noun — `support.thread`. The first segment is always the capability that declares it, so two capabilities cannot declare the same kind.",
  );
export type PresenceRoomKindName = z.infer<typeof PresenceRoomKindName>;

/** One activity a participant may announce — `viewing`, `replying`. A closed vocabulary per room kind, never free text. */
export const PresenceActivity = z
  .string()
  .regex(/^[a-z][a-z0-9_]*$/, "An activity is one lowercase word — `viewing`, `replying`.")
  .max(32)
  .describe("What a participant is doing in the room — one of the values its room kind declares, never free text.");
export type PresenceActivity = z.infer<typeof PresenceActivity>;

/**
 * The record a room is about — the id the declaring capability's own routes take. Constrained to what fits a
 * path segment and a Durable Object name without escaping.
 */
export const PresenceRecordId = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9._:-]+$/, "A record id is letters, digits, `.`, `_`, `:` and `-`.")
  .describe("The record the room is about — the id the declaring capability's own routes use for it.");
export type PresenceRecordId = z.infer<typeof PresenceRecordId>;

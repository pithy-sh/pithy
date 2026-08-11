// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { MAX_PAGE_SIZE } from "@pithy-sh/core/src/data/cursor";
import { z } from "zod";

/**
 * The HTTP boundary shapes for the secrets management routes. Everything a client can send is declared
 * here and parsed on the route line, so reading a route tells you what it accepts without opening the
 * handler. There are no bodies: this surface is read-only.
 *
 * ## Why `:name` carries no character pattern
 *
 * `defineSecretRegistry` refuses only two things in a name — empty, and the keyspace separator — so any
 * other spelling an adopter chose is a legitimate registry entry. A charset pattern here would 400 a
 * name the project genuinely declares, and a status read that cannot address a secret is worse than one
 * that answers 404 for a name that does not exist.
 *
 * The safety comes from the shape of the check instead of from the shape of the string: the handler
 * looks the name up in the composed registry by exact match and refuses anything it does not find, so
 * the only names that reach a query or a response are ones the project itself declared. Routing does
 * the rest — a keyspace member is `<keyspace>/<key>`, and a slash cannot appear in one path segment.
 *
 * The length bound is not the security control; it is the ordinary refusal to run a query over an
 * unbounded string a caller chose.
 */

/** How many rotation rows one call returns. Bounded, because a verified client can still have a bug. */
const Limit = z.coerce
  .number()
  .int()
  .min(1)
  .max(MAX_PAGE_SIZE)
  .optional()
  .describe(`How many rotation rows to return, from 1 to ${MAX_PAGE_SIZE}. Defaults to a page a screen can render.`);

export const SecretNameParam = z
  .object({
    name: z
      .string()
      .min(1)
      .max(256)
      .describe(
        "The secret to read — the `:name` path segment, matched exactly against the composed registry. A name no capability declares is a 404, not an empty history.",
      ),
  })
  .describe("The `:name` path segment naming one declared secret.");
export type SecretNameParam = z.output<typeof SecretNameParam>;

export const RotationsQuery = z
  .object({ limit: Limit })
  .describe("The rotation-history query: how many attempts to return, newest first.");
export type RotationsQuery = z.output<typeof RotationsQuery>;

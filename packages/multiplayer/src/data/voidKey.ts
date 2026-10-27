// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { SQLiteDate } from "@pithy-sh/core/src/data/codecs";
import { z } from "zod";

/**
 * One idempotency key spent on a void — the row in `pithy_multiplayer_void_keys` (#820).
 *
 * Every key a void or a retry of one was sent with, kept for as long as the result is. A result's own `voidKey` is
 * only the key that last took its void over, and a retry moves it on; this is what still knows the keys it moved
 * past. So a replayed key is a replay however many retries came after it, and a key spent on one result never voids
 * another. It names no person: a key is the management client's, and a session id is the result's.
 */
export const MultiplayerVoidKey = z
  .object({
    id: z.number().int().describe("Autoincrement primary key. Internal only; a key is looked up by voidKey."),
    voidKey: z.string().describe("The idempotency key a void, or a retry of one, was sent with. Unique."),
    sessionId: z.string().describe("The session whose result the key was spent on."),
    spentAt: SQLiteDate.describe("When the key was spent."),
  })
  .describe("One idempotency key spent on a void — the row in `pithy_multiplayer_void_keys`.");
export type MultiplayerVoidKey = z.output<typeof MultiplayerVoidKey>;

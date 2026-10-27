// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: FSL-1.1-MIT

import { AUDIT_CHAIN_FORMAT, ChainedEventFields, Sha256Hex } from "@pithy-sh/core/src/audit/chain";
import { z } from "zod";
import { type ChainRow, chainFieldsOf } from "../chain/rows";

/**
 * **One event as a sink receives it (#824)** — the chain's own canonical form, so a receiver can check it.
 *
 * Every field the event's chain hash covers, its position, the hash before it and its own hash. A receiver
 * de-duplicates a redelivery on `eventId`, which a redelivery carries unchanged, and spots a gap where a tenant's
 * `seq` skips or a `prev` names no hash it holds. With the values and the salt — only for a sink declared
 * `detail: true` — it can recompute the commitments too; without them it holds the commitments, which verify
 * against the hash and disclose nothing. It is the same serialization `pithy audit verify` checks, so what a
 * receiver holds checks against an export of the same range.
 *
 * **Not every skip is a loss.** An event the CLI records takes a position in the chain and is never shipped (see
 * `emitFromCLI`), and a sink with an `actions` filter skips what it does not take.
 *
 * **A row from before the chain**, or written by an older recorder, carries no position and no hash, and its
 * commitments are null: they were never made, and an unsalted hash of an IP address would be reversible.
 */

/** The format string of a shipped event. A new shape is a new string. */
export const AUDIT_SHIP_FORMAT = "pithy-audit-ship/1";

export const ShippedAuditEvent = ChainedEventFields.extend({
  format: z.literal(AUDIT_SHIP_FORMAT).describe("The shipped-event format."),
  chain: z.literal(AUDIT_CHAIN_FORMAT).describe("The canonical form `hash` was computed over."),
  seq: z
    .number()
    .int()
    .min(1)
    .nullable()
    .describe("The 1-based position in the tenant's chain, or null for an event outside the chain."),
  prev: Sha256Hex.nullable().describe("The hash of the event before it, or null for a chain's first event."),
  hash: Sha256Hex.nullable().describe("This event's chain hash, or null for an event outside the chain."),
  salt: z
    .string()
    .optional()
    .describe("The per-event salt the commitments were made under. Only for a sink declared `detail: true`."),
  ip: z.string().nullable().optional().describe("The client IP. Only for a sink declared `detail: true`."),
  userAgent: z.string().nullable().optional().describe("The user-agent. Only for a sink declared `detail: true`."),
  metadata: z
    .string()
    .nullable()
    .optional()
    .describe("The metadata's stored JSON text, byte for byte. Only for a sink declared `detail: true`."),
}).describe("One audit event as a sink receives it: the chain's canonical form, personal values only with detail.");
export type ShippedAuditEvent = z.infer<typeof ShippedAuditEvent>;

/** One stored row as a sink receives it. `detail` decides whether the personal values travel. */
export async function shippedEventOf(row: ChainRow, options: { detail: boolean }): Promise<ShippedAuditEvent> {
  const link = chainLinkOf(row);
  const fields = await chainFieldsOf(row, link?.salt ?? "");
  return {
    format: AUDIT_SHIP_FORMAT,
    chain: AUDIT_CHAIN_FORMAT,
    ...fields,
    ...(link ? {} : { ipCommitment: null, userAgentCommitment: null, metadataCommitment: null }),
    seq: link?.seq ?? null,
    prev: link?.prev ?? null,
    hash: link?.hash ?? null,
    ...(options.detail
      ? {
          ...(link ? { salt: link.salt } : {}),
          ip: row.ip,
          userAgent: row.userAgent,
          metadata: row.metadata,
        }
      : {}),
  };
}

/**
 * A row's place in the chain, or null for a row outside it. The type checks are not decoration, the same as the
 * reader's: SQLite reads an unknown double-quoted identifier as a string literal, so a database the app reached
 * before `audit_0005_chain` ran hands back the text `chain_seq` for the position and `chain_salt` for the salt, and
 * the recorder writes there unchained on purpose. A null check would ship those names as a position, a hash and a salt.
 */
function chainLinkOf(row: ChainRow): { seq: number; prev: string | null; hash: string; salt: string } | null {
  const { chainSeq, chainPrev, chainHash, chainSalt } = row as Record<keyof ChainRow, unknown>;
  if (typeof chainSeq !== "number" || typeof chainHash !== "string" || typeof chainSalt !== "string") return null;
  return { seq: chainSeq, prev: typeof chainPrev === "string" ? chainPrev : null, hash: chainHash, salt: chainSalt };
}

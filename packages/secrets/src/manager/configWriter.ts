// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import type { EncryptionConfig } from "../crypto/envelope";
import type { ConfigStamp, RotationPass } from "./configStamp";

/**
 * **The master-key entry's REST face**: the one seam the at-rest rotation writes
 * `SECRETS_ENCRYPTION_KEYS` through, and the one place it can ask Cloudflare what that entry looks like.
 *
 * ## Why it grew an `inspect`, and why that is not enough on its own
 *
 * The rotation writes the master-key envelope to Cloudflare Secrets Store over REST, addressed by
 * composed entry name, and every consumer reads it back through the `SECRETS_ENCRYPTION_KEYS` binding.
 * Nothing reconciled the two. A write that lands anywhere the binding does not read leaves every
 * re-encrypted row on the new key while the binding keeps handing out the old one: the environment's
 * secrets become undecryptable, silently, at the next read (`#647`).
 *
 * Cloudflare Secrets Store does not expose plaintext over REST — values are bind-only by design. So
 * **REST can prove naming and provenance and nothing else**, and this seam is honest about that:
 * {@link ConfigWriter.inspect} answers *which entry this writer addresses, whether it is there, when it
 * last changed, and what the last pass claimed about it*. Content is proven through the binding, by
 * `ConfigReader` in `./configReader.ts`, which is a **separate seam on purpose** — an implementation
 * holding both ends could satisfy a write and then answer its own read-back from memory, and every stub
 * would pass.
 *
 * The stamp check **may refuse a pass and may never satisfy one**. A matching comment does not prove
 * content, so it never substitutes for the binding read-back; it catches a write that reached a
 * different entry, or an entry edited out of band between two passes, and that is the whole of its job.
 *
 * ## The write is typed, and the stamp is derived rather than handed in
 *
 * `write` takes the `EncryptionConfig` itself rather than a pre-serialized string, so the writer — not
 * the caller — derives the stamp from the very bytes it serializes and validates the config before any
 * REST call. A caller that composed both could desynchronize them, and then the stamp proves only that
 * the caller can repeat itself.
 *
 * The name stays `ConfigWriter` though it now reads metadata too: this is the write path's seam, and
 * `inspect` exists to verify a write.
 */
export interface ConfigWriter {
  /**
   * The Secrets Store entry this writer addresses — `<project>-<env>-secrets-encryption-keys`.
   *
   * Exposed so a caller can name the target in a refusal without recomposing the naming rule. Not a
   * secret: it is the composed resource name, and it is the first fact an operator needs when a
   * write-back refuses.
   */
  readonly entryName: string;

  /**
   * Persist the master-key config to {@link entryName}, stamping the pass's provenance in the entry's
   * comment.
   *
   * **An edit, never a create.** The entry must already exist; an absent one is `core/not_found` rather
   * than a fresh entry nothing binds, and two live entries of the name are `core/conflict` with nothing
   * written. A failed write leaves the prior config intact and bound — there is no window in which the
   * key set is absent, which for this entry would be an environment-wide outage.
   */
  write(config: EncryptionConfig, pass: RotationPass): Promise<void>;

  /**
   * What Cloudflare says about {@link entryName} right now, or `null` when no entry of that name is
   * there. Metadata only — never a value, because REST has none to give. `stamp` is `null` when the
   * comment is absent, is an operator's own note, or is not a stamp this release can read.
   */
  inspect(): Promise<ConfigEntryFacts | null>;
}

/** What a REST inspection of the master-key entry can honestly report. */
export interface ConfigEntryFacts {
  /** The entry's name as Cloudflare holds it — the composed name, echoed back. */
  readonly name: string;
  /** The CF-assigned secret id, for an operator chasing a duplicate in the dashboard. */
  readonly id: string;
  /** When Cloudflare last modified the entry. */
  readonly modifiedAt: Date;
  /** The last pass's stamp, or `null` when the comment is absent, foreign, or unreadable. */
  readonly stamp: ConfigStamp | null;
}

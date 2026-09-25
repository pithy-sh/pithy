// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { z } from "zod";
import type { EncryptionConfig } from "../crypto/envelope";

/**
 * **The provenance a rotation pass writes beside the master key, and reads back over REST.**
 *
 * Cloudflare Secrets Store never serves a value over the API — values are bind-only by design — but it
 * does carry a freeform `comment` per entry, settable on a write and returned by every list. That is a
 * REST-readable channel for a non-secret assertion *about* a value nothing may read, and it is the only
 * one there is.
 *
 * So a pass stamps one. The stamp says which pointer the entry now carries, which key versions it holds,
 * which `pithy_secrets_rotations` row wrote it, and when that pass began. Four facts, plus {@link
 * MASTER_KEY_STAMP_KIND} so a comment an operator typed in the dashboard reads as *not a stamp* rather
 * than as a corrupt one.
 *
 * ## What it proves, and the larger thing it does not
 *
 * A stamp that matches what this pass just wrote says the REST edit reached the entry this writer
 * addresses, carrying this pass's own id rather than some earlier pass's — which is what makes it a
 * check and not a tautology, since a generation number repeats and a rotation id does not. It says
 * nothing about the *value*, because REST has no value to give back. **It may refuse a pass and it may
 * never satisfy one**: only the `SECRETS_ENCRYPTION_KEYS` binding can say that the bytes a Worker will
 * decrypt with are the bytes that were written, and `configReader.ts` is that seam.
 *
 * ## No field is derived from key material — not a digest, not a prefix, not a length
 *
 * This is a rule rather than a note, because the obvious next request ("prove the bytes too") points at
 * a field Cloudflare returns to anyone holding Secrets Store Read on the account, and a digest of a key
 * is a check for a guess. Every field here is a closed shape — a literal, two numeric-string shapes
 * capped at six digits, a positive integer and an ISO instant — so there is no free-text field for
 * anything to be smuggled through, and `configStamp.test.ts` pins the field set so a sixth one is a red
 * build rather than a judgment call.
 *
 * The stamp is a deliberate, accepted disclosure: the key *count* and the rotation cadence of an
 * environment become readable to a credential that can list the store. That is a version number and a
 * timestamp, and it is the price of being able to tell a write that landed from a write that went to an
 * orphan entry beside it.
 */

/**
 * The stamp format's own identifier, versioned.
 *
 * Changing what the comment carries changes this too, so a stamp written by an older release reads as
 * "not a stamp I know" rather than parsing under a rule it was not written with.
 */
export const MASTER_KEY_STAMP_KIND = "pithy.secrets.masterkey.v1";

/**
 * The most key versions a stamp will name.
 *
 * A pass adds one key and retires a generation behind it, so a healthy config holds two or three. A
 * config holding this many live keys means pruning has not run for this many passes, which is a thing to
 * notice rather than a thing to write down — and past this the stamp degrades to none rather than
 * refusing the write, because a comment must never veto persisting the key itself.
 */
export const MAX_STAMPED_VERSIONS = 64;

/**
 * The most characters a stamp may occupy in the entry's comment. Cloudflare documents no cap for the
 * field, so this ceiling is ours and is stated as ours: a truncated comment decodes as no stamp at all,
 * which would read as a failed write on an entry that took one.
 */
export const MAX_CONFIG_COMMENT = 1024;

/**
 * One master-key version key: a stringified integer, six digits at most.
 *
 * **This shape is why key material cannot reach the stamp.** A base64 AES-256 key is 44 characters and
 * carries `+`, `/` and `=`; this admits digits and nothing else, and refuses length past six. A call
 * site that handed over `Object.values(config.versions)` instead of `Object.keys(...)` is refused by the
 * schema rather than publishing thirty-two bytes of key material to a field any store listing returns.
 */
export const KeyVersion = z
  .string()
  .regex(/^(0|[1-9][0-9]{0,5})$/, { message: "A key version is a stringified integer of at most six digits." })
  .describe("One master-key version key — the stringified integer that indexes `versions`, never a key itself.");
export type KeyVersion = z.infer<typeof KeyVersion>;

/**
 * A rotation pass's provenance, as it is stored in the master-key entry's Cloudflare comment.
 *
 * See the module header for what it proves, what it deliberately does not, and why no field of it may
 * ever be derived from key material.
 */
export const ConfigStamp = z
  .object({
    kind: z
      .literal(MASTER_KEY_STAMP_KIND)
      .describe("The stamp format's identifier, so a foreign comment reads as absent rather than as garbage."),
    currentVersion: KeyVersion.describe(
      "The version key the written config points at — which master key seals new writes as of this write.",
    ),
    versions: z
      .array(KeyVersion)
      .min(1)
      .max(MAX_STAMPED_VERSIONS)
      .describe(
        "Every key version the written config carries, deduplicated and numerically sorted — version keys alone, never the keys they address.",
      ),
    rotationId: z
      .number()
      .int()
      .positive()
      .describe(
        "The `pithy_secrets_rotations` row this pass opened. It is what makes a stamp *this* pass's rather than some pass's, since a generation number repeats and a row id does not.",
      ),
    at: z.iso
      .datetime()
      .describe("The pass instant, ISO-8601 — the journalled instant of the pass, not of this write's attempt."),
  })
  .describe(
    "A rotation pass's provenance, stored in the master-key entry's Cloudflare comment: the one thing about that entry REST can read back, since its value is bind-only.",
  );
export type ConfigStamp = z.infer<typeof ConfigStamp>;

/**
 * The rotation pass a write belongs to — the two facts a stamp cannot derive from the config itself.
 *
 * Typed rather than a pre-composed string, so the stamp is underivable by the caller: a stamp built away
 * from the write is a claim nothing binds to the bytes that went with it.
 */
export interface RotationPass {
  /** The `pithy_secrets_rotations` row this pass opened, from `RotationTracker.startRotation`. */
  rotationId: number;
  /**
   * The pass instant — the journalled one, so every write of one pass carries the same instant across a
   * resume. Distinct from the config's own `lastRotatedAt`: the pointer-preserving write of step 3
   * carries the *previous* `lastRotatedAt` while belonging to *this* pass.
   */
  at: Date;
}

/**
 * Derive the stamp for a config a pass is about to write, or `null` when it will not compose.
 *
 * **It reads `Object.keys(config.versions)` and never the values**, and the schema refuses the values
 * anyway — two layers, because one of them is a habit and the other is a type.
 *
 * **It degrades rather than refusing, and that direction is deliberate.** The comment is a verification
 * aid; the value beside it is the key that decrypts an environment. A stamp that will not compose must
 * not be able to stop the key being persisted, so the caller writes the value with no comment and the
 * read-back afterwards finds no stamp — which, by the rule in the module header, may refuse a pass and
 * may never satisfy one, so an absent stamp costs the pass nothing it was relying on.
 */
export function configStamp(config: EncryptionConfig, pass: RotationPass): ConfigStamp | null {
  const versions = [...new Set(Object.keys(config.versions))].sort((left, right) => Number(left) - Number(right));
  const parsed = ConfigStamp.safeParse({
    kind: MASTER_KEY_STAMP_KIND,
    currentVersion: config.currentVersion,
    versions,
    rotationId: pass.rotationId,
    at: pass.at.toISOString(),
  });
  if (!parsed.success) return null;
  // A pointer the key set does not hold is not a stamp anybody should be reassured by. It is also the
  // state `#647`'s step 4 exists to prevent, and `pithy secrets verify` reports it as a finding.
  if (!parsed.data.versions.includes(parsed.data.currentVersion)) return null;
  return parsed.data;
}

/**
 * Serialize a stamp for the entry's comment, or `null` when it would not fit.
 *
 * Fixed key order, so one stamp is one sequence of bytes on every pass and a diff of two comments is a
 * diff of two rotations.
 */
export function encodeConfigStamp(stamp: ConfigStamp): string | null {
  const comment = JSON.stringify({
    kind: stamp.kind,
    currentVersion: stamp.currentVersion,
    versions: stamp.versions,
    rotationId: stamp.rotationId,
    at: stamp.at,
  });
  return comment.length > MAX_CONFIG_COMMENT ? null : comment;
}

/**
 * Read a stamp back out of an entry's comment, or `null`.
 *
 * **Never throws.** The comment is a field an operator may write in the Cloudflare dashboard, and a
 * human's note there must read as "no stamp", not as a failed rotation. Absent, empty, oversized, not
 * JSON, a different `kind`, or a shape this release cannot parse all answer the same way — and the
 * caller's decision is identical for every one of them, because none of them refuses anything.
 */
export function decodeConfigStamp(comment: string | null | undefined): ConfigStamp | null {
  // **`null` as well as `undefined`, because that is what Cloudflare actually sends (#647).** An entry
  // nothing annotated comes back with an explicit `comment: null`, not an absent key — measured against a
  // real store, where every one of the ten entries present reported exactly that. All three of absent, null
  // and unparseable mean the same thing here and answer the same way: there is no stamp of ours to compare,
  // which refuses nothing, because an operator's own note in the dashboard looks identical from here.
  if (comment === undefined || comment === null) return null;
  if (comment.length === 0 || comment.length > MAX_CONFIG_COMMENT) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(comment);
  } catch {
    return null;
  }
  const parsed = ConfigStamp.safeParse(raw);
  return parsed.success ? parsed.data : null;
}

/**
 * Whether two stamps are the same claim.
 *
 * **`rotationId` is compared, and that is the whole reason this is a function rather than a pointer
 * check.** A pass that staged key 2 and then aborted leaves a stamp naming version 2 on the entry; a
 * later pass that stages 2 again would find it and call its own write confirmed by a comment it never
 * wrote. The row id is unique per pass, so the comparison asks *this write*, not *a write like it*.
 */
export function sameConfigStamp(left: ConfigStamp, right: ConfigStamp): boolean {
  return (
    left.kind === right.kind &&
    left.currentVersion === right.currentVersion &&
    left.rotationId === right.rotationId &&
    left.at === right.at &&
    left.versions.length === right.versions.length &&
    left.versions.every((version, index) => version === right.versions[index])
  );
}

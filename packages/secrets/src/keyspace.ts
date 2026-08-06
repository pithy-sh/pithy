// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { ValidationError } from "@pithy-sh/core/src/error/pithyError";
import { z } from "zod";

/**
 * Keyspaces — the naming rule behind a `keyed` registry entry.
 *
 * A named entry is one secret with one value. A keyed entry declares a *keyspace*: one schema, one
 * backend, and an unbounded set of members whose keys only exist at runtime — one signing key per
 * customer connection, one credential per tenant. The registry can no more list those names than it
 * can list next month's customers.
 *
 * A member is stored under `<entry>/<key>` in the same encrypted store as everything else, so at-rest
 * rotation, the audit and teardown all keep working with no second storage path. `/` is the one
 * separator, and `defineSecretRegistry` refuses it in an entry name — so a keyspace member can never
 * collide with a declared secret, and no key can compose its way into a neighbouring keyspace.
 *
 * That is the whole security argument, and it rests on {@link SecretKey}: every key is validated
 * before it is composed, so `../OTHER/victim` is refused at the call rather than resolved at the
 * store. One tenant's credential is not reachable with another tenant's key.
 */

/** The one separator between a keyspace and a member key. Illegal in a registry entry name. */
export const KEYSPACE_SEPARATOR = "/";

/** Longest member key. Generous for a uuid or a prefixed id; short enough to keep a stored name bounded. */
const MAX_KEY_LENGTH = 128;

export const SecretKey = z
  .string()
  .regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/)
  .max(MAX_KEY_LENGTH)
  .describe(
    "A keyspace member key supplied at runtime — a tenant, connection, or installation id. Letters, digits, dot, dash and underscore only, starting with a letter or digit, at most 128 characters: the separator, whitespace and control characters are excluded so a key can never compose its way out of its keyspace.",
  );
export type SecretKey = z.output<typeof SecretKey>;

/**
 * The stored name of one keyspace member. The only sanctioned way to compose one — read and write
 * both go through here, so there is a single place where a key is proven legal.
 *
 * The refusal names the keyspace and never the key. `detail` reaches logs verbatim, and a rejected
 * key is unvalidated input: echoing it would put attacker-chosen bytes, newlines included, in the
 * operator's log.
 */
export function keyedSecretName(name: string, key: string): string {
  const parsed = SecretKey.safeParse(key);
  if (!parsed.success) {
    throw new ValidationError({
      message: "That secret key is not valid.",
      action: "Use letters, digits, dot, dash or underscore — starting with a letter or digit, up to 128 characters.",
      detail: `keyspace '${name}': the supplied key failed SecretKey validation`,
    });
  }
  return `${name}${KEYSPACE_SEPARATOR}${parsed.data}`;
}

/**
 * Split a stored name back into its keyspace and key, or `undefined` when it is not a keyspace
 * member. The audit uses it to attribute a stored member to the keyspace that declared it, so a
 * tenant's credential is not reported as an orphan.
 */
export function parseKeyedSecretName(stored: string): { name: string; key: string } | undefined {
  const at = stored.indexOf(KEYSPACE_SEPARATOR);
  if (at <= 0) return undefined;
  const key = stored.slice(at + 1);
  return SecretKey.safeParse(key).success ? { name: stored.slice(0, at), key } : undefined;
}

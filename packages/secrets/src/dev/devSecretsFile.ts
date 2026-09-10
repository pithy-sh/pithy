// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { z } from "zod";
import { VersionedValue } from "../crypto/versionedValue";
import { SecretInvalidValueError } from "../error/errors";
import type { SecretRegistryEntry, SecretValueType } from "../registry";

/**
 * The dev secrets file — the one hand-edited input for **local dev** secret values, and the format
 * of the file the CLI seeds from.
 *
 * `.dev.vars` is what wrangler says it is: env bindings, `UPPER_SNAKE`, in the worker's directory
 * because wrangler reads it there. Secrets live here instead, keyed by the **registry secret name
 * verbatim** — `<capability>-<what>`, kebab — because that name is the join key into the registry,
 * and a mapping table between the two would be one more thing to rot.
 *
 * **Nothing in this file names a destination.** The registry already knows each secret's `backend`,
 * so the seeder derives where a value goes, and the file and the registry can never disagree.
 *
 * **And nothing here names its location, either.** Since #156 the file is machine-local, at
 * `<config>/<project>/secrets.jsonc` — outside every checkout, resolved by the CLI. This package is
 * Workers-runtime code with no `node:` imports and no filesystem: it parses text and returns what
 * should be written. The path a caller passes is for error messages, and is always absolute in
 * practice; {@link DEV_SECRETS_FILE} is only what an error says when a caller named nothing.
 */

/** The file's bare name, for an error raised by a caller that passed no path. Mode `0600`. */
export const DEV_SECRETS_FILE = "secrets.jsonc";

/**
 * The envelope, spelled out, so every error can show the shape rather than describe it.
 *
 * Here rather than in one reader, because two readers now say it — the loader and the payload reader —
 * and a shape quoted twice is a shape that will be quoted two ways.
 */
export const ENVELOPE_SHAPE = '{ "currentVersion": "1", "versions": { "1": <value> } }';

/**
 * The committed example — the one artifact about secrets that stays in an adopter's repository, and
 * documentation only. It is never copied to a working file: `pithy add` writes the real one, outside
 * the checkout, and there is nothing in the project for it to sit beside.
 */
export const DEV_SECRETS_EXAMPLE_FILE = ".dev.secrets.example.jsonc";

/**
 * ## The rule, stated once (#323)
 *
 * **A secret's entry in this file is the precise payload its destination receives. Nothing wraps it,
 * nothing unwraps it, and no secret is an exception.**
 *
 * The registry says what that payload is, per secret, and `devSecretPayload` (`./seedDevSecrets`) is
 * the one reading of it:
 *
 * | secret | destination | payload |
 * |---|---|---|
 * | any ordinary secret | a D1 row, a `.dev.vars` line, a Secrets Store entry | a {@link DevSecretEnvelope} |
 * | a `bootstrap` secret | its binding, read before any decoder exists | the value itself |
 *
 * There is one widening, for the person hand-editing the file: a `json` value is written as its own
 * structure rather than as an escaped string inside a string, and the reader serializes it on the way
 * out. That is a JSON-in-JSON concession, not a wrapper — nothing is added and nothing is removed.
 *
 * ## Which means a `json` secret has **two** stored forms, and this is where they are written down (#535)
 *
 * | where | a `json` secret's form | who validates it |
 * |---|---|---|
 * | this file | the value's **own structure** | `storedVersion` — `entry.schema.safeParse(value)`, no parse first |
 * | a D1 row, a Secrets Store entry | the **canonical string** | `validateSecretValue` on write, `parseValue` on read |
 *
 * They are not in tension: `storedSecretValue` turns the first into the second, and that conversion is
 * the whole of the difference. But nothing said so, and one writer that serialized before handing the
 * value over therefore satisfied one destination and corrupted the other — `pithy turnstile provision`
 * put a JSON string containing JSON in this file, which `TurnstileSecrets` refuses at the root because
 * it is a `z.strictObject` handed a string. `seedDevSecrets.test.ts` pins the two forms to each other,
 * so a reader who finds only one of them cannot conclude it is the only one.
 *
 * **A value is checked against its schema when it is written, not when it is next read.** Both forms
 * have that now — {@link initialDevSecret} for this file, `validateSecretValue` for a managed write —
 * and it is what turns a writer's wrong guess about the encoding into a failed command rather than a
 * value that sits in three environments until `pithy doctor` mentions it.
 *
 * **Why `bootstrap` is not an exception to the rule but an instance of it.** `SECRETS_ENCRYPTION_KEYS`
 * is what the envelope decoder needs in order to exist, so its binding has always carried a bare
 * `EncryptionConfig` and `resolveEncryptionConfig` has always parsed one. The file used to state an
 * envelope around it and the seeder used to take that envelope off again — a `currentVersion` for one
 * concept written twice, carrying no information, and reported as file corruption by two readers in a
 * row. Now the file states what the binding gets.
 */

/**
 * One secret's value in the file, for **every secret whose destination receives an envelope** — which
 * is every secret that is not `bootstrap`. Always full, even for a single-version text secret.
 *
 * **This is the whole reason the format is unambiguous, not ceremony — do not "simplify" it away.**
 * With optional envelopes a JSON-valued secret's own object cannot be told apart from an envelope
 * without a marker or a heuristic: `{ "clientId": …, "clientSecret": … }` and
 * `{ "currentVersion": …, "versions": … }` are both just objects. Requiring the envelope wherever the
 * destination takes one means the outer object is *always* the envelope, and a JSON secret's own
 * object sits unambiguously inside `versions`. It also matches what is actually stored, so dev stops
 * being a shape production never sees — and `pithy secrets rotate --env dev` exercises the real
 * rotation path. **The registry, not a heuristic, is what says which secrets those are.**
 *
 * The shape is {@link VersionedValue}'s, widened in exactly one place: a stored version is a string
 * (a `json` secret stores its serialized form), while a hand-written one is the value itself, so that
 * an adopter writes real structure rather than an escaped string inside a string. The seeder converts,
 * validating each version against the registry entry's schema on the way.
 *
 * **Strict, and that is what makes the guarantee above true (#323).** Stripping unknown keys instead
 * of refusing them is the same permissiveness the doc argues against, arriving by the back door: an
 * `EncryptionConfig` is `{ currentVersion, versions, lastRotatedAt }`, a structural *superset* of an
 * envelope, so a stripping parser accepted `SECRETS_ENCRYPTION_KEYS`' own value written bare, dropped
 * `lastRotatedAt`, and left a base64 string where a nested object belongs. The failure then surfaced
 * three frames later, naming neither the file nor the secret. Refusing here says it once, in place.
 */
export const DevSecretEnvelope = VersionedValue.extend({
  versions: z
    .record(z.string(), z.unknown())
    .describe(
      "Every still-valid version: version key (a stringified integer) → the value itself — a string for a `text` secret, its own object for a `json` one. Always at least one entry.",
    ),
})
  .strict()
  .describe(
    "One secret's value in the dev secrets file, for every secret whose destination receives an envelope: an explicit current-version pointer plus every still-valid version, and nothing else. Always full, never partial.",
  );
export type DevSecretEnvelope = z.output<typeof DevSecretEnvelope>;

/**
 * What was found where an envelope belongs, as one clause for the caller's sentence — `it carries
 * lastRotatedAt …`, `it is a string`, `it has no versions`.
 *
 * **Keys and types only, never a value.** The reason a shape error is worth saying at all is that the
 * adopter is looking at a file they hand-wrote; the reason it must say this much and no more is that
 * the same file holds OAuth client secrets, and this sentence reaches a terminal and a log.
 */
export function describeNotEnvelope(value: unknown, error: z.ZodError): string {
  if (value === null) return "it is null";
  if (Array.isArray(value)) return "it is an array";
  if (typeof value !== "object") return `it is a ${typeof value}`;
  const unrecognized = error.issues.flatMap(unrecognizedKeys).sort();
  if (unrecognized.length > 0) {
    return `it carries ${unrecognized.join(", ")} beside currentVersion and versions, so it is a value's own object rather than an envelope around one`;
  }
  const absent = ["currentVersion", "versions"].filter((key) => !Object.hasOwn(value, key));
  if (absent.length > 0) return `it has no ${absent.join(" and no ")}`;
  return "currentVersion must be a string and versions a map of version key to value";
}

/** The keys one `unrecognized_keys` issue names, or none — narrowed rather than cast (no `any`). */
function unrecognizedKeys(issue: z.core.$ZodIssue): string[] {
  if (issue.code !== "unrecognized_keys") return [];
  return issue.keys.filter((key): key is string => typeof key === "string");
}

/**
 * The whole file: registry secret name → **payload**. A record rather than a fixed object, because the
 * declared set is whatever capabilities the project composes — the registry is the authority on that,
 * not this schema.
 *
 * **The value is `unknown` here, and that is the shape of the rule rather than a gap in it (#323).**
 * Which payload a name takes is the registry's answer, not this schema's: an ordinary secret's is a
 * {@link DevSecretEnvelope}, a `bootstrap` secret's is its own value. A schema that named one of them
 * for every entry would be the wrapper this issue removed, written as a type. `devSecretPayload`
 * (`./seedDevSecrets`) is where a name and a registry entry meet, and it is the kit's only payload reader.
 */
export const DevSecretsFile = z
  .record(z.string(), z.unknown())
  .describe(
    "The parsed dev secrets file: registry secret name (`<capability>-<what>`) → the exact payload its destination receives. The registry decides which shape that is, and where the value is seeded.",
  );
export type DevSecretsFile = z.output<typeof DevSecretsFile>;

/**
 * The entry a freshly-minted dev value is written into the file as — **the payload its destination
 * receives**, and nothing around it.
 *
 * For an ordinary secret that is a one-version envelope, the counterpart of `initialVersionedValue`
 * over the file's wider version type. For a `bootstrap` secret it is the value, because the value is
 * what its binding carries.
 *
 * **Every writer goes through here.** `pithy add secrets`, the provisioners and the seeder's own mint
 * all call it, so there is one statement of what a fresh entry looks like. A second
 * writer composing the envelope inline is how #323 got two shapes for one file.
 *
 * **And because every writer goes through here, this is where a value is checked against the schema
 * its own registry declares (#535).** `pithy turnstile provision` wrote a serialized `TurnstileSecrets`
 * where the file states the structure, so the entry held a JSON string containing JSON. Nothing refused
 * it: the writer reported success, and the value's own schema — a `z.strictObject`, handed a string —
 * first rejected it at the next `pithy seed`, in `storedVersion`, on a machine and a day unrelated to
 * the run that wrote it. It is the same check, moved to the moment there is still something to fix, and
 * `entry.schema` is the only thing that can make it: a writer's own idea of the shape is what drifted.
 *
 * An entry that declares no `valueType` — `{}`, passed by a caller holding a manifest rather than a
 * registry — is not checked, because nothing here knows what to check it against. Silence there is the
 * absence of a declaration, not a verdict.
 */
export function initialDevSecret(entry: DevSecretShape, value: unknown): unknown {
  assertStatedShape(entry, value);
  return entry.bootstrap === true ? value : { currentVersion: "1", versions: { "1": value } };
}

/**
 * What {@link initialDevSecret} reads off a registry entry: whether it is enveloped, and its shape.
 *
 * Every field optional, because a whole {@link SecretRegistryEntry} is one caller and `{}` is another —
 * `pithy add` composes an entry from a capability's manifest, which carries a name and no schema.
 */
interface DevSecretShape {
  bootstrap?: boolean;
  valueType?: SecretValueType;
  schema?: z.ZodType;
}

/**
 * Refuse a value the entry's own schema refuses, before it is composed into a file entry.
 *
 * Redacted like every other refusal on this surface: Zod `path:code` pairs and the field names, never
 * `issue.message` or `received`, either of which echoes credential material into a terminal and a log.
 */
function assertStatedShape(entry: DevSecretShape, value: unknown): void {
  if (entry.valueType !== "json" || entry.schema === undefined) return;
  const result = entry.schema.safeParse(value);
  if (result.success) return;
  const fields = [...new Set(result.error.issues.map((issue) => issue.path.join(".") || "<root>"))].join(", ");
  const summary = result.error.issues.map((issue) => `${issue.path.join(".") || "<root>"}:${issue.code}`).join(", ");
  throw new SecretInvalidValueError({
    message: `A secret value failed validation before it was written: ${fields}.`,
    action:
      "Write the value its registry entry declares. A json secret states its own structure, never a string of JSON.",
    detail: `dev secrets file: json value failed registry validation on write: ${summary}`,
  });
}

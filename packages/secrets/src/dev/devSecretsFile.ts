// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { z } from "zod";
import { VersionedValue } from "../crypto/versionedValue";

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
 * The committed example — the one artefact about secrets that stays in an adopter's repository, and
 * documentation only. It is never copied to a working file: `pithy add` writes the real one, outside
 * the checkout, and there is nothing in the project for it to sit beside.
 */
export const DEV_SECRETS_EXAMPLE_FILE = ".dev.secrets.example.jsonc";

/**
 * One secret's value in the file: **always** a full `{ currentVersion, versions }` envelope, even for
 * a single-version text secret.
 *
 * **This is the whole reason the format is unambiguous, not ceremony — do not "simplify" it away.**
 * With optional envelopes a JSON-valued secret's own object cannot be told apart from an envelope
 * without a marker or a heuristic: `{ "clientId": …, "clientSecret": … }` and
 * `{ "currentVersion": …, "versions": … }` are both just objects. Requiring the envelope everywhere
 * means the outer object is *always* the envelope, and a JSON secret's own object sits unambiguously
 * inside `versions`. It also matches what is actually stored, so dev stops being a shape production
 * never sees — and `pithy secrets rotate --env dev` exercises the real rotation path.
 *
 * The shape is {@link VersionedValue}'s, widened in exactly one place: a stored version is a string
 * (a `json` secret stores its serialized form), while a hand-written one is the value itself, so that
 * an adopter writes real structure rather than an escaped string inside a string. The seeder converts,
 * validating each version against the registry entry's schema on the way.
 */
export const DevSecretEnvelope = VersionedValue.extend({
  versions: z
    .record(z.string(), z.unknown())
    .describe(
      "Every still-valid version: version key (a stringified integer) → the value itself — a string for a `text` secret, its own object for a `json` one. Always at least one entry.",
    ),
}).describe(
  "One secret's value in the dev secrets file: an explicit current-version pointer plus every still-valid version. Always a full envelope, never a bare value.",
);
export type DevSecretEnvelope = z.output<typeof DevSecretEnvelope>;

/**
 * The whole file: registry secret name → envelope. A record rather than a fixed object, because the
 * declared set is whatever capabilities the project composes — the registry is the authority on that,
 * not this schema.
 */
export const DevSecretsFile = z
  .record(z.string(), DevSecretEnvelope)
  .describe(
    "The parsed dev secrets file: registry secret name (`<capability>-<what>`) → its versioned envelope. The registry, not this file, decides where each value is seeded.",
  );
export type DevSecretsFile = z.output<typeof DevSecretsFile>;

/**
 * The envelope a freshly-minted dev value is written back into the file as: version 1 is current and
 * holds the value. The counterpart of `initialVersionedValue`, over the file's wider version type.
 */
export function initialDevSecret(value: unknown): DevSecretEnvelope {
  return { currentVersion: "1", versions: { "1": value } };
}

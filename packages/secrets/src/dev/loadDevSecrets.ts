// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { ValidationError } from "@pithy-sh/core/src/error/pithyError";
import { parse } from "comment-json";
import { DEV_SECRETS_FILE, DevSecretEnvelope, DevSecretsFile } from "./devSecretsFile";

/**
 * The dev secrets file boundary. Text in, a validated {@link DevSecretsFile} out — and every way
 * the text can be wrong comes back as a `ValidationError` that names **which secret** and what to do.
 * A Zod dump is not an answer to "my app will not start": the adopter hand-writes this file, so the
 * error has to read like the fix.
 *
 * **JSONC**, parsed with `comment-json`, so the comments that say what a secret is for and the
 * trailing comma left behind by deleting a line both survive. The parse is comment-stripping: this
 * returns data. A caller writing minted values back re-parses with `comment-json` and edits that
 * tree, which is how an adopter's comments survive a write.
 *
 * **Bytes are the caller's problem.** This package is Workers-runtime code and holds no `node:`
 * imports; the CLI reads the file (and owns its `0600` mode, and its absence meaning "no secrets
 * yet"). The same rule the seeder follows for `.dev.vars`: return what should be written, never write.
 *
 * The registry is deliberately absent here. Structure is checked at the boundary; a value's *meaning*
 * — its type, its schema, where it belongs — is the registry's, and `seedDevSecrets` is where the two
 * meet. That keeps one place where the file and the registry are compared.
 */

/** Options for {@link loadDevSecrets}. */
export interface LoadDevSecretsOptions {
  /**
   * The path to name in errors — the one the caller read, so a message points at a real file in a
   * multi-project checkout. Defaults to {@link DEV_SECRETS_FILE}.
   */
  path?: string;
}

/** The envelope, spelled out, so every error can show the shape rather than describe it. */
const ENVELOPE_SHAPE = '{ "currentVersion": "1", "versions": { "1": <value> } }';

/**
 * Parse and validate the dev secrets file. Throws `validation/invalid_input` naming the offending
 * secret. Nothing thrown from here carries a value: `message`, `action` and `detail` all reach a
 * terminal or a log, and the file holds OAuth client secrets.
 */
export function loadDevSecrets(source: string, options: LoadDevSecretsOptions = {}): DevSecretsFile {
  const path = options.path ?? DEV_SECRETS_FILE;

  // A file with nothing in it is a project with no secrets yet — the same answer an absent file gets,
  // and the same one the write path already gives when it merges a mint into empty content. A
  // `touch`ed file used to fail `pithy add` outright, which is one state with two answers.
  if (source.trim().length === 0) return {};

  let parsed: unknown;
  try {
    parsed = parse(source, undefined, true);
  } catch (cause) {
    // **No `cause`, deliberately.** `comment-json`'s `SyntaxError` reads `Unexpected token '"', "{ …
    // the entire file … }" is not valid JSON` — it embeds the source, so attaching it would carry
    // every OAuth client secret in the file into whatever logs or prints the error chain. The
    // position is kept, because a line and a column are not a value.
    throw new ValidationError({
      message: `${path} is not valid JSONC.`,
      // **No command named here.** It said "run pithy seed", and the seed is rarely what failed —
      // `pithy dev`, `pithy add` and `pithy secrets edit` all read this file, and the last of those
      // printed advice to run itself while the adopter was inside it (#157). This function does not
      // know which command is running, so it says what is wrong and leaves the command to the caller.
      // The path is in `message`, which is what an adopter actually needs: the file is outside the
      // checkout (#156), so naming it is the difference between a fixable fault and a hunt.
      action: "Fix the syntax and try again. Comments and trailing commas are fine; unquoted keys are not.",
      detail: `dev secrets file '${path}' failed to parse${position(cause)}`,
    });
  }

  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new ValidationError({
      message: `${path} must be an object of secret name to versioned envelope.`,
      action: `Write each secret as "<capability>-<what>": ${ENVELOPE_SHAPE}.`,
      detail: `dev secrets file '${path}' top level is ${Array.isArray(parsed) ? "an array" : typeof parsed}`,
    });
  }

  const file: DevSecretsFile = {};
  for (const [name, value] of Object.entries(parsed as Record<string, unknown>)) {
    file[name] = readEnvelope(path, name, value);
  }
  return DevSecretsFile.parse(file);
}

/**
 * The parse error's position, as ` at line L column C`, or nothing when the parser did not give one.
 *
 * The only part of a `SyntaxError` from `comment-json` that is safe to repeat. Its `message` quotes
 * the source it choked on — the whole file — so nothing else from it is carried anywhere.
 */
function position(cause: unknown): string {
  if (typeof cause !== "object" || cause === null) return "";
  const { line, column } = cause as { line?: unknown; column?: unknown };
  if (typeof line !== "number" || typeof column !== "number") return "";
  return ` at line ${line} column ${column}`;
}

/**
 * One secret's value, checked as a full envelope. The three failures are separated because they have
 * different fixes: a value that is not an envelope at all is the migration case (it was a `.dev.vars`
 * line yesterday); an empty `versions` and a dangling `currentVersion` are hand-edit slips, and saying
 * which one it is saves a round of guessing.
 */
function readEnvelope(path: string, name: string, value: unknown): DevSecretEnvelope {
  const result = DevSecretEnvelope.safeParse(value);
  if (!result.success) {
    throw new ValidationError({
      message: `Secret '${name}' in ${path} is not a versioned envelope.`,
      action: `Write it as ${ENVELOPE_SHAPE}. Every value is a full envelope, so a JSON secret's own object is never mistaken for one.`,
      detail: `dev secrets file '${path}': '${name}' is not a { currentVersion, versions } envelope`,
    });
  }

  const envelope = result.data;
  if (Object.keys(envelope.versions).length === 0) {
    throw new ValidationError({
      message: `Secret '${name}' in ${path} has no versions.`,
      action: `Give it at least one: ${ENVELOPE_SHAPE}.`,
      detail: `dev secrets file '${path}': '${name}' has an empty versions map`,
    });
  }
  // `Object.hasOwn`, never `in`: `in` walks the prototype chain, so a `currentVersion` of `toString`
  // or `constructor` passed this check and failed much later inside the store, with an error naming
  // neither the file nor the secret.
  if (!Object.hasOwn(envelope.versions, envelope.currentVersion)) {
    throw new ValidationError({
      message: `Secret '${name}' in ${path} points at version '${envelope.currentVersion}', which it does not have.`,
      action: "Set currentVersion to a key that is present in versions.",
      detail: `dev secrets file '${path}': '${name}' currentVersion is absent from versions`,
    });
  }
  return envelope;
}

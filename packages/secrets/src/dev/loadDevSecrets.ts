// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { ValidationError } from "@pithy-sh/core/src/error/pithyError";
import { parse } from "comment-json";
import type { SecretRegistry } from "../registry";
import { DEV_SECRETS_FILE, DevSecretsFile, ENVELOPE_SHAPE } from "./devSecretsFile";
import { devSecretPayload } from "./seedDevSecrets";

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
 * **The registry is optional here, and what it buys is exactly the shape check (#323).** Which payload
 * a name takes — an envelope, or the value itself for a `bootstrap` secret — is the registry's answer,
 * so a loader without one cannot judge a slot and does not pretend to: it establishes that the text is
 * a JSONC object of secret names, and `devSecretPayload` judges each value where the registry is in
 * hand. Given a registry, it asks that same function per declared name, so a bad shape is caught at
 * the boundary and in one wording. A name the registry does not declare is left alone either way —
 * a removed capability must not brick dev, and `seedDevSecrets` reports it as undeclared.
 */

/** Options for {@link loadDevSecrets}. */
export interface LoadDevSecretsOptions {
  /**
   * The path to name in errors — the one the caller read, so a message points at a real file in a
   * multi-project checkout. Defaults to {@link DEV_SECRETS_FILE}.
   */
  path?: string;
  /**
   * The project's registry, when the caller has one. Every declared name's value is then checked
   * against the payload its destination takes, which is the only way that question has an answer.
   *
   * Absent for a caller that has no project loaded — `pithy secrets edit` on a project whose config
   * will not load is the case that matters, and it is the command an adopter reaches for to *fix* that.
   */
  registry?: SecretRegistry;
}

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
      message: `${path} must be an object of secret name to value.`,
      action: `Write each secret as "<capability>-<what>": the payload its destination receives — ${ENVELOPE_SHAPE} for an ordinary secret.`,
      detail: `dev secrets file '${path}' top level is ${Array.isArray(parsed) ? "an array" : typeof parsed}`,
    });
  }

  const file: DevSecretsFile = {};
  const registry = options.registry;
  for (const [name, value] of Object.entries(parsed as Record<string, unknown>)) {
    // The registry entry, or nothing. `Object.hasOwn`, never `in`: `in` walks the prototype chain, so a
    // secret named `toString` would be judged against an `Object.prototype` member.
    const entry = registry && Object.hasOwn(registry, name) ? registry[name] : undefined;
    // A name with no value at all, which is knowable without a registry and is the one shape check left
    // here. `comment-json` parses `{ "a-b": }` to `undefined` rather than refusing it, so a half-deleted
    // line reached the seeder as a declared secret holding nothing.
    if (value === undefined) {
      throw new ValidationError({
        message: `Secret '${name}' in ${path} has no value.`,
        action: `Give it one, or delete the line. An ordinary secret's is ${ENVELOPE_SHAPE}.`,
        detail: `dev secrets file '${path}': '${name}' has no value`,
      });
    }
    // Judged, and then discarded: what this returns is the file's own values, not the converted ones.
    // A keyspace is not judged at all — it has no single value, and `seedDevSecrets` owns that refusal.
    if (entry && !entry.keyed) devSecretPayload(entry, name, value, path);
    file[name] = value;
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

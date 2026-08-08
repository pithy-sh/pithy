// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { parseDevVars } from "@pithy-sh/cloudflare/src/env/devVars";
import { InternalError } from "@pithy-sh/core/src/error/pithyError";
import type { StatePathOptions } from "../notifier/state";
import { readOptionalFile } from "../project/readOptionalFile";
import { writeBootstrapVars } from "./bootstrapVars";
import { generateDevVars } from "./generate";
import type { DevSecretsTarget } from "./targets";

/**
 * The one place a value becomes a `.dev.vars` line — and the one place that makes sure the line reaches
 * the Worker that has to read it.
 *
 * Two defects lived here, and both were silent, which is why this is a funnel rather than a fix at each
 * of the four call sites that had them.
 *
 * **Values were written raw.** wrangler parses `.dev.vars` with `dotenv`, whose unquoted value grammar
 * is `[^#\r\n]+` — so `KEY=s3cr3t#tail` hands the Worker `s3cr3t`, with no warning anywhere. A generated
 * key is base64 and never contains a `#`; an OAuth client secret is whatever the provider issued, and
 * this file is where those land. The failure arrives at the first sign-in, as a signature that does not
 * verify, against a value that looks present in every file you would think to check.
 *
 * **And the line went somewhere the Worker does not read.** `pithy dev` spawns wrangler with
 * `cwd: apps/<worker>`, and wrangler loads the `.dev.vars` beside the Worker's own config — so a value
 * written to the project root alone landed in a file nothing reads. That was solved with a symlink into
 * each `apps/<worker>/`, and the symlink produced five defects of its own. It is solved by generation
 * now: see {@link ./generate}, which owns the whole destination side.
 *
 * **The encoding is verified, not reasoned about.** {@link encodeDevVarsValue} tries the three forms
 * dotenv accepts and keeps the first one that survives a round trip through *both* readers — wrangler's
 * and ours. A value no form survives is refused by name. That is deliberately stricter than a rule
 * about which characters are dangerous: the rule would need updating for the shape nobody thought of,
 * and the round trip already covers it.
 *
 * **A refusal is fail-closed, and now structurally.** The binding is the only place a `cf-secrets-store`
 * secret is read from, so a refused value that left the superseded line in place handed the Worker the
 * *previous* secret while every report said the value was replaced. The generated file is built from the
 * sources every run rather than upserted into, so a refused value has no line to leave behind.
 *
 * **What this function still owns is persistence.** A generated file cannot be its own source of truth,
 * so a value written here goes to the machine-local bootstrap store (`./bootstrapVars`) and the Workers'
 * files are regenerated from it. That is what makes a master key minted by `pithy add secrets` survive to
 * the next `pithy dev` without `.dev.vars` accumulating state nobody can regenerate.
 */

/** What one value's encoding produced: the bytes to write, or the sentence saying why nothing was. */
export interface DevVarsEncoding {
  /** The text that goes after `KEY=`, ready to write. `null` when no faithful encoding exists. */
  encoded: string | null;
  /** Why the value cannot be written, naming the secret and never its value. `null` when it can. */
  refused: string | null;
}

/**
 * `dotenv@16.3.1`'s line grammar, copied verbatim from the parser wrangler ships
 * (`node_modules/wrangler/wrangler-dist/cli.js`, `var LINE = …`).
 *
 * It is exported so a test can assert it still appears in that bundle byte for byte. A copy that drifts
 * from wrangler's is worse than no copy at all: {@link encodeDevVarsValue} verifies every value against
 * it, so a drift would silently bless an encoding the Worker reads differently.
 */
export const DOTENV_LINE =
  /(?:^|^)\s*(?:export\s+)?([\w.-]+)(?:\s*=\s*?|:\s+?)(\s*'(?:\\'|[^'])*'|\s*"(?:\\"|[^"])*"|\s*`(?:\\`|[^`])*`|[^#\r\n]+)?\s*(?:#.*)?(?:$|$)/gm;

/**
 * Parse a `.dev.vars` body the way **wrangler** does — quoted spans, inline `#` comments, and the
 * `\n`/`\r` expansion a double-quoted value gets. This is the reader whose answer the Worker actually
 * receives, so it is the one an encoding has to satisfy.
 *
 * Not a replacement for `parseDevVars`. That one is what pithy's own commands read the file with, and
 * the two disagree — on `#`, on backticks, on escapes. Both are checked, because a value that reads one
 * way in the Worker and another in `pithy doctor` is its own bug.
 */
export function parseDotenv(source: string): Record<string, string> {
  const vars: Record<string, string> = {};
  const line = new RegExp(DOTENV_LINE.source, DOTENV_LINE.flags);
  const body = source.toString().replace(/\r\n?/gm, "\n");
  let match: RegExpExecArray | null = line.exec(body);
  while (match !== null) {
    const key = match[1];
    let value = (match[2] ?? "").trim();
    const quote = value[0];
    value = value.replace(/^(['"`])([\s\S]*)\1$/gm, "$2");
    if (quote === '"') value = value.replace(/\\n/g, "\n").replace(/\\r/g, "\r");
    if (key !== undefined) vars[key] = value;
    match = line.exec(body);
  }
  return vars;
}

/** The three forms dotenv accepts, in the order they are tried: as-is, single-quoted, double-quoted. */
function candidates(value: string): string[] {
  const forms = [value];
  if (!value.includes("'")) forms.push(`'${value}'`);
  if (!value.includes('"')) forms.push(`"${value}"`);
  return forms;
}

/**
 * Encode one value for `.dev.vars`, or refuse.
 *
 * A candidate is accepted only when writing `NAME=<candidate>` and reading it back gives the value
 * again — through wrangler's parser *and* through pithy's. The plain form is tried first, so the
 * overwhelming majority of values (base64 keys, JSON envelopes) are written exactly as they always
 * were and no existing file churns.
 *
 * The name is checked by the same round trip rather than by a separate rule: dotenv's key grammar is
 * `[\w.-]+`, so a secret named with a `:` produces a line the Worker never sees at all. Silence is the
 * worst answer available for a secret, so that is a refusal too.
 */
export function encodeDevVarsValue(name: string, value: string): DevVarsEncoding {
  for (const candidate of candidates(value)) {
    const line = `${name}=${candidate}\n`;
    if (parseDotenv(line)[name] === value && parseDevVars(line)[name] === value) {
      return { encoded: candidate, refused: null };
    }
  }
  return {
    encoded: null,
    refused: `${name} cannot be written to .dev.vars — no quoting survives its value. It belongs in the dev secrets file; see #153.`,
  };
}

/** What {@link writeDevVars} needs. Every seam defaults to the real project. */
export interface WriteDevVarsOptions {
  /** The project root — owner of `apps/`, of the `.dev.vars.local` files, and of the project's name. */
  projectDir: string;
  /**
   * The values to record in `dev.json`, by variable name. **Only what no registry declares** — a
   * Turnstile sitekey, a machine-local endpoint. A registry secret's value belongs in `secrets.jsonc`,
   * which the generator reads directly (#179). Empty records nothing and regenerates anyway.
   */
  values: Record<string, string>;
  /** The Worker directories to generate into. Defaults to every discovered Worker with a `wrangler.jsonc`. */
  workerDirs?: string[];
  /** The Workers whose registries decide which secrets are materialised. Defaults to every one composing `secrets`. */
  targets?: DevSecretsTarget[];
  /** Where the Pithy config directory is. Defaults to the real one; a seam so a test writes its own. */
  paths?: StatePathOptions;
}

/** What one write did. Every list is sorted, so two runs of the same state read the same. */
export interface WriteDevVarsResult {
  /** The variable names actually recorded — the ones an encoding survives. */
  written: string[];
  /**
   * One sentence per value or Worker directory that did not get one: a value no quoting survives, a
   * `.dev.vars` pithy did not generate, a directory this project may not write into. Never a value.
   */
  refused: string[];
  /** Worker directories whose `.dev.vars` this run wrote. */
  generated: string[];
  /** Worker directories whose `.dev.vars` already held exactly these bytes. No bytes written, mtime intact. */
  unchanged: string[];
  /** Worker directories whose `.dev.vars` was a symlink from the old shared-file design, now a real file. */
  relinked: string[];
  /** Every variable name the generated files carry, sorted. Names only — never a value, anywhere. */
  names: string[];
}

/**
 * Record values in the machine-local bootstrap store, then regenerate every Worker's `.dev.vars` from it.
 *
 * Mode `0600` on every file written, the same as the dev secrets file: this one holds the dev master key
 * and every `cf-secrets-store` value, and the umask default is world-readable.
 */
export async function writeDevVars(options: WriteDevVarsOptions): Promise<WriteDevVarsResult> {
  const written: string[] = [];
  const refused: string[] = [];
  const encoded: Record<string, string> = {};
  for (const name of Object.keys(options.values).sort()) {
    const value = options.values[name];
    if (value === undefined) continue;
    // Encoded here only to decide whether the value can be delivered at all. The bootstrap store keeps
    // the plain value — quoting is `.dev.vars` grammar, and a quoted value round-tripped through a JSON
    // file would acquire a second layer of it on the next generation.
    const result = encodeDevVarsValue(name, value);
    if (result.encoded === null) {
      if (result.refused !== null) refused.push(result.refused);
      continue;
    }
    encoded[name] = value;
    written.push(name);
  }

  await writeBootstrapVars(options.projectDir, encoded, options.paths ?? {});
  // Regenerated from the **sources**, never from what was just recorded. A generator handed a value set
  // by its caller is a generator that can disagree with the files it claims to read — which is exactly
  // how a `cf-secrets-store` secret came to reach a Worker one `pithy seed` after it was rotated (#179).
  const generated = await generateDevVars({
    projectDir: options.projectDir,
    ...(options.workerDirs !== undefined ? { workerDirs: options.workerDirs } : {}),
    ...(options.targets !== undefined ? { targets: options.targets } : {}),
    ...(options.paths !== undefined ? { paths: options.paths } : {}),
  });

  return {
    written,
    refused: [...refused, ...generated.refused].sort(),
    generated: generated.generated,
    unchanged: generated.unchanged,
    relinked: generated.relinked,
    names: generated.names,
  };
}

/**
 * The file's bytes, or `null` when there is no file — and **only** when there is no file.
 *
 * The rule and its three producers now live in {@link readOptionalFile} (`../project/`). What stays here
 * is what is `.dev.vars`-shaped: the sentence an adopter reads, the mode it names, and *why* absence had
 * to stop meaning "unreadable" for this file in particular. Reading `EACCES` or `EIO` as "empty" meant
 * the next content was built from an empty base and renamed over a file full of values this process never
 * saw — the adopter's `CLOUDFLARE_API_TOKEN` and every other line, gone, with the run reporting a clean
 * write. The same defect `readSource` was written to end for the dev secrets file, in the file beside it,
 * twice over.
 *
 * The wrapped error carries the node error as `cause`. Its message is a path and an errno, never a line
 * of the file.
 *
 * **Exported because reading this file honestly is not only the writer's problem.** `pithy add` asks the
 * same question — is this secret already here? — and its own `.catch(() => "")` answered "no" for an
 * unreadable file, so `add` minted a second value and the project held two under one name, one in each
 * file. Three readers of one file is how one of them keeps getting it wrong.
 */
export async function readDevVarsSource(path: string): Promise<string | null> {
  return readOptionalFile(path, {
    unreadable: ({ code, cause }) =>
      new InternalError(
        {
          message: ".dev.vars is there and could not be read.",
          action: `Check ${path} and its permissions. It should be a file, mode 600.`,
          detail: `.dev.vars '${path}' failed to read: ${code ?? "unknown error"}`,
        },
        { cause },
      ),
  });
}

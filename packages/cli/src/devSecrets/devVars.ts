// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { lstat, readFile, symlink } from "node:fs/promises";
import { join, relative } from "node:path";
import { parseDevVars } from "@pithy-sh/cloudflare/src/env/devVars";
import { writeFileAtomic } from "../project/atomic";
import { upsertDevVarsContent } from "../project/devVars";
import { discoverWorkers } from "../project/workers";

/**
 * The one place a secret value becomes a `.dev.vars` line — and the one place that makes sure the line
 * reaches the Worker that has to read it.
 *
 * Two defects live here, and both were silent, which is why they get a funnel rather than a fix at each
 * of the four call sites that had them.
 *
 * **Values were written raw.** wrangler parses `.dev.vars` with `dotenv`, whose unquoted value grammar
 * is `[^#\r\n]+` — so `KEY=s3cr3t#tail` hands the Worker `s3cr3t`, with no warning anywhere. A generated
 * key is base64 and never contains a `#`; an OAuth client secret is whatever the provider issued, and
 * this file is where those land. The failure arrives at the first sign-in, as a signature that does not
 * verify, against a value that looks present in every file you would think to check.
 *
 * **And the line went somewhere the Worker does not read.** `pithy dev` spawns wrangler with
 * `cwd: apps/<worker>`, and wrangler loads the `.dev.vars` beside the Worker's own config. The project
 * root's file is linked into each Worker by `pithy feature` and by `pithy worker add` — never by
 * `pithy init`. So on a plain project every value written here landed in a file nothing reads: a fresh
 * `pithy init` + `pithy add auth` + `pithy dev` answered `Secret binding 'auth-session-secret' is not
 * configured.` with the row seeded, the envelope in `.dev.secrets.jsonc`, and the line in `.dev.vars`.
 * Writing the value and delivering it are one operation here, so a fifth producer cannot get one right
 * and the other wrong.
 *
 * **The encoding is verified, not reasoned about.** {@link encodeDevVarsValue} tries the three forms
 * dotenv accepts and keeps the first one that survives a round trip through *both* readers — wrangler's
 * and ours. A value no form survives is refused by name. That is deliberately stricter than a rule
 * about which characters are dangerous: the rule would need updating for the shape nobody thought of,
 * and the round trip already covers it.
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
    refused: `${name} cannot be written to .dev.vars — no quoting survives its value. Put it in .dev.secrets.jsonc and see #153.`,
  };
}

/** What {@link writeDevVars} needs. `workerDirs` is the seam; it defaults to the project's own Workers. */
export interface WriteDevVarsOptions {
  /** The project root — owner of the one `.dev.vars` every Worker resolves to. */
  projectDir: string;
  /** The values to upsert, by variable name. Empty writes nothing and touches nothing. */
  values: Record<string, string>;
  /** The Worker directories to deliver to. Defaults to every discovered Worker with a `wrangler.jsonc`. */
  workerDirs?: string[];
}

/** What one write did. Every list is sorted, so two runs of the same state read the same. */
export interface WriteDevVarsResult {
  /** The variable names actually written. */
  written: string[];
  /** One sentence per value that could not be encoded. Never a value. */
  refused: string[];
  /** Worker directories whose `.dev.vars` this call created as a link to the project's. */
  linked: string[];
  /**
   * Worker directories holding a `.dev.vars` of their own. wrangler reads *that* file, so nothing
   * written here reaches them — and their file is theirs, so it is reported rather than replaced.
   */
  shadowed: string[];
}

/**
 * Write values into the project's `.dev.vars` and make sure every Worker resolves to it.
 *
 * Mode `0600`, the same as `.dev.secrets.jsonc`: through the transition this file holds the very same
 * session keys and link-signing keys, and the umask default is world-readable.
 */
export async function writeDevVars(options: WriteDevVarsOptions): Promise<WriteDevVarsResult> {
  const written: string[] = [];
  const refused: string[] = [];
  const encoded: Record<string, string> = {};
  for (const name of Object.keys(options.values).sort()) {
    const value = options.values[name];
    if (value === undefined) continue;
    const result = encodeDevVarsValue(name, value);
    if (result.encoded === null) {
      if (result.refused) refused.push(result.refused);
      continue;
    }
    encoded[name] = result.encoded;
    written.push(name);
  }
  if (written.length === 0) return { written, refused, linked: [], shadowed: [] };

  const path = join(options.projectDir, ".dev.vars");
  const content = await readFile(path, "utf8").catch(() => "");
  await writeFileAtomic(path, upsertDevVarsContent(content, encoded), { mode: 0o600 });

  const dirs = options.workerDirs ?? (await workerDirs(options.projectDir));
  const linked: string[] = [];
  const shadowed: string[] = [];
  for (const dir of dirs) {
    if (dir === options.projectDir) continue;
    const target = join(dir, ".dev.vars");
    const stats = await lstat(target).catch(() => null);
    // An existing symlink points where somebody meant it to — a feature worktree's link at the main
    // checkout's shared file, most often. Repointing it at this project's copy would take a worktree
    // off the file the whole repo shares.
    if (stats?.isSymbolicLink()) continue;
    if (stats !== null) {
      shadowed.push(dir);
      continue;
    }
    // Relative, so a project that is copied, moved, or mounted at another path still resolves.
    await symlink(relative(dir, path), target).catch(() => {});
    linked.push(dir);
  }
  return { written, refused, linked: linked.sort(), shadowed: shadowed.sort() };
}

/** Every Worker directory wrangler will run in — the ones with a `wrangler.jsonc` to load `.dev.vars` beside. */
async function workerDirs(projectDir: string): Promise<string[]> {
  const workers = await discoverWorkers(projectDir).catch(() => []);
  return workers.filter((worker) => worker.hasWrangler !== false).map((worker) => worker.dir);
}

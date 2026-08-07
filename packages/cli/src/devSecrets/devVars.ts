// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { lstat, readFile, readlink, symlink } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { parseDevVars } from "@pithy-sh/cloudflare/src/env/devVars";
import { InternalError } from "@pithy-sh/core/src/error/pithyError";
import { writeFileAtomic } from "../project/atomic";
import { removeDevVarsContent, upsertDevVarsContent } from "../project/devVars";
import { discoverWorkers } from "../project/workers";
import { tightenMode } from "./mode";

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
 * configured.` with the row seeded, the envelope in the dev secrets file, and the line in `.dev.vars`.
 * Writing the value and delivering it are one operation here, so a fifth producer cannot get one right
 * and the other wrong.
 *
 * **The encoding is verified, not reasoned about.** {@link encodeDevVarsValue} tries the three forms
 * dotenv accepts and keeps the first one that survives a round trip through *both* readers — wrangler's
 * and ours. A value no form survives is refused by name. That is deliberately stricter than a rule
 * about which characters are dangerous: the rule would need updating for the shape nobody thought of,
 * and the round trip already covers it.
 *
 * **A refusal is fail-closed.** `.dev.vars` is the only place dev reads until #153, so a refused value
 * that leaves the superseded line in place hands the Worker the *previous* secret while every report
 * says the value was replaced. Wrong-and-silent beats broken-and-loud for nothing, least of all a
 * secret, so the stale line goes and the refusal says it went.
 *
 * **And delivery is checked, never assumed.** Three ways it used not to happen, all silently. A failed
 * `symlink()` was swallowed and the directory counted as linked anyway. A worker whose `.dev.vars` is a
 * symlink was skipped without asking where it pointed. And in the layout `pithy feature create` and
 * `pithy worker add` produce — a worktree root and every worker inside it symlinked at the main
 * checkout's one shared file — the atomic write *replaced* the root's link with a private file and left
 * every worker on the untouched original. Verified against a real one: `pithy feature create`, then
 * `writeDevVars`, then `wrangler dev` in the worktree, and the Worker served the superseded value while
 * the result read `written: ["auth-session-secret"], shadowed: []`. So the write follows the link to
 * the file it names, and each worker's link is resolved and compared with the file that was written.
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
   * Worker directories reading a `.dev.vars` that is not the one written — a file of their own, or a
   * link pointing somewhere else. wrangler reads *that* file, so nothing written here reaches them, and
   * it is theirs, so it is reported rather than replaced.
   */
  shadowed: string[];
  /**
   * One sentence per Worker directory the value could not be delivered to: the link could not be made,
   * or the one already there resolves to nothing. Either way wrangler will open no `.dev.vars` at all.
   * Separate from {@link shadowed} because that is somebody's arrangement and this is a failure. Never a
   * value.
   */
  undelivered: string[];
}

/**
 * Write values into the project's `.dev.vars` and make sure every Worker resolves to it.
 *
 * Mode `0600`, the same as the dev secrets file: through the transition this file holds the very same
 * session keys and link-signing keys, and the umask default is world-readable.
 */
export async function writeDevVars(options: WriteDevVarsOptions): Promise<WriteDevVarsResult> {
  const written: string[] = [];
  const refusals: { name: string; reason: string }[] = [];
  const encoded: Record<string, string> = {};
  for (const name of Object.keys(options.values).sort()) {
    const value = options.values[name];
    if (value === undefined) continue;
    const result = encodeDevVarsValue(name, value);
    if (result.encoded === null) {
      if (result.refused) refusals.push({ name, reason: result.refused });
      continue;
    }
    encoded[name] = result.encoded;
    written.push(name);
  }
  if (written.length === 0 && refusals.length === 0) {
    return { written, refused: [], linked: [], shadowed: [], undelivered: [] };
  }

  // The path the project names, and the file it actually resolves to. In a feature worktree they are
  // different: the root's `.dev.vars` is a link at the main checkout's shared file, and writing the link
  // path atomically renames a new file over the link — cutting the worktree off the file every worker in
  // it still points at.
  //
  // **This resolution belongs in the atomic writer, and it moves there on the rebase.** Resolving the
  // chain here and handing the result to `writeFileAtomic` makes the write follow a symlink with no rule
  // about whose link it is: plant `.dev.vars` at a path outside the project and the freshly minted master
  // key lands there. The rule cannot be stated here, either — a worktree's link points outside the
  // project *by design*, so location cannot tell the two apart. `writeFileAtomic` on
  // `fix/scaffold-cannot-run` resolves the chain itself and refuses any link a different uid made, which
  // is the rule that can. This branch rebases onto it, and this line goes in the same commit.
  //
  // Dropping the resolution *before* that branch lands would not close the hole, it would trade it for a
  // silent delivery failure: the rename would replace the worktree's link with a private file while every
  // worker in it still read the main checkout's, and the result would still say `written`. That is the
  // defect this whole file exists to end, and it needs no attacker. See #160 for the threat model that
  // says the planter can wait and the accident cannot.
  const path = join(options.projectDir, ".dev.vars");
  const target = await followLink(path);
  const content = await readDevVarsSource(target);
  const before = parseDevVars(content ?? "");
  // Fail-closed: a value that could not be encoded takes its superseded line with it.
  const stale = refusals.filter(({ name }) => Object.hasOwn(before, name));
  const next = upsertDevVarsContent(
    removeDevVarsContent(
      content ?? "",
      stale.map(({ name }) => name),
    ),
    encoded,
  );
  // Never conjure an empty `.dev.vars` out of a run whose every value was refused, and never rewrite a
  // file whose bytes would not change. `null` is "no file", and no file plus nothing to say stays that way.
  if (next !== (content ?? "")) await writeFileAtomic(target, next, { mode: 0o600 });
  // Unconditionally, and *after* the write: the guard above is right and it left the mode to a write that
  // may never happen, so a file created at the umask by anything else — an older pithy, an editor, a
  // `cp` — kept 0644 forever while holding the session key. Narrowing only, so an adopter's deliberate
  // 0400 survives. See {@link tightenMode}.
  await tightenMode(target);

  const refused = refusals.map(({ name, reason }) =>
    stale.some((entry) => entry.name === name)
      ? `${reason} Its superseded line was removed — a stale value that still works is worse than none.`
      : reason,
  );
  if (written.length === 0) return { written, refused, linked: [], shadowed: [], undelivered: [] };

  const dirs = options.workerDirs ?? (await workerDirs(options.projectDir));
  const linked: string[] = [];
  const shadowed: string[] = [];
  const undelivered: string[] = [];
  for (const dir of dirs) {
    if (dir === options.projectDir) continue;
    const beside = join(dir, ".dev.vars");
    const stats = await lstat(beside).catch(() => null);
    if (stats !== null) {
      // An existing link points where somebody meant it to — at the repo's shared file, most often — so
      // it is never repointed. But where it points decides whether the value arrived, and that is asked
      // rather than assumed: a link at some other file is as undelivered as a file of the worker's own.
      if (stats.isSymbolicLink()) {
        const resolved = await followLink(beside).catch(() => null);
        if (resolved === target) continue;
        // A link that resolves to nothing is not somebody's arrangement, it is a fault: wrangler opens
        // no file there at all. Reporting it as shadowed would read as "theirs to keep".
        if (resolved === null) {
          undelivered.push(`${dir} has a .dev.vars whose symlink chain never ends. wrangler opens nothing there.`);
          continue;
        }
      }
      shadowed.push(dir);
      continue;
    }
    // Relative, so a project that is copied, moved, or mounted at another path still resolves.
    const failure = await symlink(relative(dir, path), beside).then(
      () => null,
      (err: unknown) => (err instanceof Error ? err.message : String(err)),
    );
    // A swallowed failure is a delivery that did not happen, reported as one. For a secret that is the
    // worst answer available: everything downstream reads as written and the Worker has no binding.
    if (failure === null) linked.push(dir);
    else undelivered.push(`${dir} has no .dev.vars and one could not be linked: ${failure}`);
  }
  return { written, refused, linked: linked.sort(), shadowed: shadowed.sort(), undelivered: undelivered.sort() };
}

/** How many links deep a chain may go before it is called a loop. Well past anything deliberate. */
const MAX_LINK_HOPS = 32;

/**
 * The real file a path names, following symlinks by hand — `realpath` refuses a dangling link, and a
 * `.dev.vars` link at a main checkout that has not written one yet is exactly that.
 *
 * Bounded, because a symlink loop is a hang and this runs inside `pithy dev`. **At the bound it throws.**
 * It used to return what it had, with a docstring promising the write would then fail loudly — and the
 * write did not fail at all. What came back was still a symlink, so `writeFileAtomic` renamed a fresh
 * file over the link and reported the value written: the same silent detachment the worktree case exists
 * to prevent, reached by a link that points at itself rather than by one that points somewhere else.
 */
async function followLink(path: string): Promise<string> {
  let current = path;
  for (let hop = 0; hop < MAX_LINK_HOPS; hop += 1) {
    const stats = await lstat(current).catch(() => null);
    if (stats === null || !stats.isSymbolicLink()) return current;
    const next = await readlink(current).catch(() => null);
    if (next === null) return current;
    current = resolve(dirname(current), next);
  }
  throw new InternalError({
    message: `Refusing to touch ${path}: its symlink chain never ends.`,
    action: "Fix the link — something in the chain points back at itself.",
    detail: `more than ${MAX_LINK_HOPS} symlinks deep from '${path}'`,
  });
}

/**
 * The file's bytes, or `null` when there is no file — and **only** when there is no file.
 *
 * `ENOENT` is the one errno that means "nothing written yet". Every other one is a file that is there and
 * did not open: `EACCES` after someone tightened the mode, `EISDIR`, `EIO` on failing disk. Reading those
 * as "empty" meant the next content was built from an empty base and renamed over a file full of values
 * this process never saw — the adopter's `CLOUDFLARE_API_TOKEN` and every other line, gone, with the run
 * reporting a clean write. The same defect `readSource` was written to end for the dev secrets file, in
 * the file beside it, twice over.
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
  try {
    return await readFile(path, "utf8");
  } catch (cause) {
    const code = (cause as { code?: string } | null)?.code;
    if (code === "ENOENT") return null;
    throw new InternalError(
      {
        message: ".dev.vars is there and could not be read.",
        action: `Check ${path} and its permissions. It should be a file, mode 600.`,
        detail: `.dev.vars '${path}' failed to read: ${code ?? "unknown error"}`,
      },
      { cause },
    );
  }
}

/** Every Worker directory wrangler will run in — the ones with a `wrangler.jsonc` to load `.dev.vars` beside. */
async function workerDirs(projectDir: string): Promise<string[]> {
  const workers = await discoverWorkers(projectDir).catch(() => []);
  return workers.filter((worker) => worker.hasWrangler !== false).map((worker) => worker.dir);
}

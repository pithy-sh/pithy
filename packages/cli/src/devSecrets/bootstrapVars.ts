// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { readFile } from "node:fs/promises";
import { ConflictError } from "@pithy-sh/core/src/error/pithyError";
import { z } from "zod";
import type { StatePathOptions } from "../notifier/state";
import { writeFileAtomic } from "../project/atomic";
import { loadProject, requireProjectName } from "../project/config";
import { type MergeBase, readMergeBase } from "../project/readOptionalFile";
import { devPreferencesPath } from "../seed/prepare";
import { ensureDevSecretsDir } from "./location";
import { tightenMode } from "./mode";

/**
 * The bootstrap half of a generated `.dev.vars`: the values a Worker reads from an **env binding** rather
 * than from a secrets store — the dev master key, a `cf-secrets-store` secret, a Turnstile sitekey.
 *
 * **It lives in `dev.json`, as a second tenant (#154).** `<config>/<project>/dev.json` was already there
 * for dev-login preferences (#131), it is already machine-local, already outside every checkout, and
 * already the file `pithy doctor` names. Inventing a second location for "the machine's dev values" would
 * have been a third convention for the same directory.
 *
 * **Why it has to persist anywhere at all.** `.dev.vars` used to be the store: `pithy add secrets` minted
 * a master key into it and every later run read it back from there. A generated file cannot be its own
 * source of truth — regenerating it would mean reading what the last generation wrote, which is the
 * accumulating file this change exists to end. So the values move one level out, to the place the
 * secrets file already went, and the generated file becomes a pure function of them.
 *
 * **Not a second copy of the secrets file.** `secrets.jsonc` holds application secrets as versioned
 * envelopes, seeded into a Worker's local `SECRETS` store. This holds the flat `KEY=value` set that has
 * to be a binding, because dev has no Secrets Store to read one from. A `d1` secret is never here.
 *
 * Same directory, same 0700, same 0600 as its neighbour — for the same reason: the dev master key is in
 * it, and the umask is not a permission policy for a credential.
 */

/** The `dev.json` key this set lives under. Namespaced, because the file has other tenants. */
export const BOOTSTRAP_VARS_KEY = "vars";

/**
 * The bootstrap set as it appears in `dev.json` — a flat map of `.dev.vars` variable names to values.
 *
 * Validated because it is read off disk and hand-editable, and it decides what a Worker's bindings are.
 * A non-string value would reach {@link import("./devVars").encodeDevVarsValue} as an object and be
 * written as `[object Object]`.
 */
export const BootstrapVars = z
  .record(
    z.string().describe("The `.dev.vars` variable name — wrangler's namespace, so UPPER_SNAKE by convention."),
    z.string().describe("The value the Worker's binding carries. Never logged, never printed, never in --json."),
  )
  .describe("Every value this machine has to hand a Worker through a .dev.vars binding, by variable name.");

/** The bootstrap set. Same name as its schema, as every Zod object in this repo is. */
export type BootstrapVars = z.output<typeof BootstrapVars>;

/**
 * The shape this module reads `dev.json` as: its own key, and every other tenant's, preserved.
 *
 * `catchall` rather than a closed object, because a write here must not delete the dev-login preferences
 * sitting beside it. Two tenants in one file is the whole reason the key exists.
 *
 * **Exported so a caller planning a write into this file reads it through one schema (#222).** A
 * planning read goes through `readMergeBase` against this schema, so what it computes is a `dev.json`
 * that was actually read rather than a `{}` a lenient read invented. One schema, because two would be
 * two answers to "what is in that file", and a plan is what somebody deletes a line on the strength of.
 */
export const DevJson = z
  .object({
    [BOOTSTRAP_VARS_KEY]: BootstrapVars.optional().describe("The bootstrap `.dev.vars` set — this module's tenant."),
  })
  .catchall(z.unknown().describe("Another tenant's key, read and written back untouched."))
  .describe("This machine's per-project dev file, of which the bootstrap vars are one tenant.");

/** The whole file, every tenant included. Same name as its schema, as every Zod object in this repo is. */
export type DevJson = z.output<typeof DevJson>;

/** `<config>/<project>/dev.json` for a project root, or `null` when the project has no name to key on. */
export async function bootstrapVarsPath(projectDir: string, options: StatePathOptions = {}): Promise<string | null> {
  try {
    return devPreferencesPath(requireProjectName(await loadProject(projectDir)), options);
  } catch {
    return null;
  }
}

/**
 * This project's bootstrap set, or an empty one. **The reporting read of the two in this file.**
 *
 * **Every failure is an empty set, and that is deliberate here where it is a defect elsewhere.** The
 * sibling readers refuse an unreadable credential file because they are about to *rewrite* it, and
 * "absent" would license replacing what they could not read. Nothing is rewritten from this call — the
 * result is merged into a file that is regenerated wholesale — so a `dev.json` that will not parse costs
 * a set of bindings and says so through the Worker's own missing-binding error, rather than stopping
 * `pithy dev` over a hand-edited preferences file. This is the read `pithy dev` starts through.
 *
 * **What that argument is not about (#219).** It is an argument about *this call*, and it was read for a
 * while as if it were about the file: the two writers below reached the same `{}` through
 * {@link readDevJson} and renamed a document built from it over a file with another tenant in it. They
 * refuse now, in every state but "there is no file", and this one still answers `{}` — the split is the
 * fix, not a tightening. It is a type rather than a convention: they take a {@link MergeBase}, which only
 * `readMergeBase` mints, so nothing that reads leniently can be handed to them by accident.
 *
 * So this read deliberately does *not* go through the primitive, and it is written down as such in that
 * module's gate (`../project/readOptionalFile.test.ts`) rather than left to be rediscovered.
 */
export async function readBootstrapVars(projectDir: string, options: StatePathOptions = {}): Promise<BootstrapVars> {
  const path = await bootstrapVarsPath(projectDir, options);
  if (path === null) return {};
  const source = await readFile(path, "utf8").catch(() => null);
  if (source === null) return {};
  const parsed = DevJson.safeParse(safeJson(source));
  if (!parsed.success) return {};
  return parsed.data[BOOTSTRAP_VARS_KEY] ?? {};
}

/**
 * Merge `values` into this project's bootstrap set and write `dev.json` back. Returns the merged set,
 * so a caller regenerating from it never re-reads what it has just written.
 *
 * **Read-modify-write over a file with other tenants**, so every state but "there is no file" refuses:
 * writing this set over a `dev.json` that could not be read, or is not JSON, or parsed to something that
 * is not a document, or is a record of something else, would silently delete a developer's dev-login
 * preference along with every value this module had. Only `ENOENT` licenses starting from `{}`.
 *
 * A value is never removed here. A name that leaves the registry leaves a line nothing reads; `pithy
 * doctor` is where a value nobody declares gets named, in this file exactly as in its neighbour.
 *
 * **An empty `values` returns before the read, and that is a decision (#222).** The refusal above exists
 * because a merge into an invented `{}` gets renamed over another tenant's keys; a call that writes
 * nothing performs no merge and no rename, so there is nothing for it to protect. It was reached —
 * `writeDevVars({ values: {} })` is the turnstile teardown's regeneration — where refusing turns a
 * regeneration into a failure over a file the run was never going to touch. The split in this module is
 * by *power*, not by file, and a write of nothing has a reader's power: the set it answers is
 * {@link readBootstrapVars}'s, which is the read whose whole argument is that it rewrites nothing.
 */
export async function writeBootstrapVars(
  projectDir: string,
  values: Record<string, string>,
  options: StatePathOptions = {},
): Promise<BootstrapVars> {
  const path = await bootstrapVarsPath(projectDir, options);
  if (path === null) return {};
  if (Object.keys(values).length === 0) return readBootstrapVars(projectDir, options);
  const base = await readDevJson(path);
  const merged: BootstrapVars = { ...(base.document[BOOTSTRAP_VARS_KEY] ?? {}), ...values };
  await ensureDevSecretsDir(base.path);
  await writeFileAtomic(base.path, `${JSON.stringify(withBootstrapVars(base, merged), null, 2)}\n`, {
    mode: 0o600,
  });
  // Unconditionally and after the write, the same as the secrets file's: a `dev.json` an older pithy or an
  // editor created at the umask kept 0644 while holding the dev master key. Narrowing only.
  await tightenMode(base.path);
  return merged;
}

/**
 * The document to write: every tenant's key as it was read, with this module's set replaced.
 *
 * **It takes a {@link MergeBase} and that is the whole point (#219).** Only `readMergeBase` mints one, so
 * {@link readBootstrapVars} — which answers `{}` for a file it cannot make sense of, correctly, because
 * it rewrites nothing — cannot be handed to it. The accident that produced five instances of this defect
 * is a type error here rather than another tenant's key gone at the next rename.
 */
function withBootstrapVars(base: MergeBase<DevJson>, vars: BootstrapVars): DevJson {
  return { ...base.document, [BOOTSTRAP_VARS_KEY]: vars };
}

/**
 * Take names out of this project's bootstrap set — the teardown half, for a value whose resource no
 * longer exists. Returns the set that remains, so a caller regenerating from it never re-reads.
 *
 * A name that is not there is a no-op, and a project with no `dev.json` is not created one. Removing a
 * value here is what makes the next generation drop its line: the generated file is built from the
 * sources rather than edited, so there is no line to delete anywhere else.
 *
 * **That no-op still reads strictly, and its sibling does not — same rule, different answer (#222).** The
 * early return belongs before the read exactly when the *caller's arguments* settle whether anything is
 * written. {@link writeBootstrapVars} knows that from an empty `values`. This one only learns it from the
 * file, and a file nothing could read supports no claim about what is in it — least of all "that name is
 * not there". So the one case its arguments do settle, an empty `names`, returns before the read, and
 * every other case earns its no-op by reading the document properly or refusing.
 */
export async function removeBootstrapVars(
  projectDir: string,
  names: readonly string[],
  options: StatePathOptions = {},
): Promise<BootstrapVars> {
  const path = await bootstrapVarsPath(projectDir, options);
  if (path === null) return {};
  if (names.length === 0) return readBootstrapVars(projectDir, options);
  const base = await readDevJson(path);
  const current: BootstrapVars = base.document[BOOTSTRAP_VARS_KEY] ?? {};
  const remaining = Object.fromEntries(Object.entries(current).filter(([name]) => !names.includes(name)));
  if (Object.keys(remaining).length === Object.keys(current).length) return current;
  await ensureDevSecretsDir(base.path);
  await writeFileAtomic(base.path, `${JSON.stringify(withBootstrapVars(base, remaining), null, 2)}\n`, {
    mode: 0o600,
  });
  await tightenMode(base.path);
  return remaining;
}

/**
 * The merge base for a write over `dev.json`: every tenant's key intact, known-good, or a refusal.
 *
 * **The writers' read, and the strict half of this file's split.** `{}` for an absent file and for
 * nothing else. Unopenable, not JSON, parsed to something that is not a document, or a document of
 * something else: four refusals, because the two writers below merge into this answer and rename the
 * result over a file with another tenant in it. Answering `{}` for any of the four is a dev-login
 * preference and this module's own set deleted, with the run reporting a clean write.
 *
 * It used to answer `{}` for a non-object (#209), and then for a file that would not parse and for one
 * that failed its schema (#219) — each corrected once someone noticed that the argument for leniency was
 * {@link readBootstrapVars}'s and had been read as if it belonged to the file. The two are different
 * calls with different powers, and now different types: this one hands back a {@link MergeBase}, which
 * nothing else in this repository can produce.
 *
 * The `ENOENT`-only rule and the other three are `readMergeBase`'s (`../project/readOptionalFile.ts`);
 * the words below are this file's, because "cannot update" is what a read-modify-write over somebody
 * else's tenants has to say.
 */
async function readDevJson(path: string): Promise<MergeBase<DevJson>> {
  return readMergeBase(path, DevJson, {
    unreadable: ({ code, cause }) =>
      new ConflictError(
        {
          message: `Cannot update ${path}: Pithy could not read what is already in it.`,
          action: "Fix the file's permissions, or move it aside, and run the command again.",
          detail: `${code ?? "unknown error"} while reading ${path}`,
        },
        { cause },
      ),
    unparseable: () =>
      new ConflictError({
        message: `Cannot update ${path}: it is there and is not JSON.`,
        action: "Fix the JSON, or move it aside, and run the command again.",
        // Never the parser's own message: it quotes the line it choked on, and the dev master key is one.
        detail: `dev.json at ${path} did not parse, and every tenant's keys would be replaced by a write from it`,
      }),
    notARecord: ({ found }) =>
      new ConflictError({
        message: `Cannot update ${path}: it holds ${found}, not a document.`,
        action: "Restore it to a JSON object, or move it aside, and run the command again.",
        detail: `dev.json at ${path} parsed to ${found}, and other tenants' keys would be replaced by a write from it`,
      }),
    invalid: ({ at }) =>
      new ConflictError({
        message: `Cannot update ${path}: it is not the document Pithy keeps there.`,
        action: "Fix it, or move it aside, and run the command again.",
        // The key path, so the line can be found. Never the value on it, which may be the dev master key.
        detail: `dev.json at ${path} failed its schema at ${at}`,
      }),
  });
}

/** `JSON.parse` that answers `undefined` rather than throwing — this file is hand-edited. */
function safeJson(source: string): unknown {
  try {
    return JSON.parse(source);
  } catch {
    return undefined;
  }
}

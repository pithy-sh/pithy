// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { readFile } from "node:fs/promises";
import { ConflictError } from "@pithy-sh/core/src/error/pithyError";
import { z } from "zod";
import type { StatePathOptions } from "../notifier/state";
import { writeFileAtomic } from "../project/atomic";
import { loadProject, requireProjectName } from "../project/config";
import { readOptionalFile } from "../project/readOptionalFile";
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
 */
const DevJson = z
  .object({
    [BOOTSTRAP_VARS_KEY]: BootstrapVars.optional().describe("The bootstrap `.dev.vars` set — this module's tenant."),
  })
  .catchall(z.unknown().describe("Another tenant's key, read and written back untouched."))
  .describe("This machine's per-project dev file, of which the bootstrap vars are one tenant.");

/** `<config>/<project>/dev.json` for a project root, or `null` when the project has no name to key on. */
export async function bootstrapVarsPath(projectDir: string, options: StatePathOptions = {}): Promise<string | null> {
  try {
    return devPreferencesPath(requireProjectName(await loadProject(projectDir)), options);
  } catch {
    return null;
  }
}

/**
 * This project's bootstrap set, or an empty one.
 *
 * **Every failure is an empty set, and that is deliberate here where it is a defect elsewhere.** The
 * sibling readers refuse an unreadable credential file because they are about to *rewrite* it, and
 * "absent" would license replacing what they could not read. Nothing is rewritten from this call — the
 * result is merged into a file that is regenerated wholesale — so a `dev.json` that will not parse costs
 * a set of bindings and says so through the Worker's own missing-binding error, rather than stopping
 * `pithy dev` over a hand-edited preferences file. {@link writeBootstrapVars} is the one that refuses.
 *
 * So this read deliberately does *not* go through {@link readOptionalFile}, and it is written down as
 * such in that module's gate (`../project/readOptionalFile.test.ts`) rather than left to be rediscovered.
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
 * **Read-modify-write over a file with other tenants**, so an unreadable-but-present file refuses rather
 * than being replaced: writing this set over a `dev.json` that could not be read would silently delete a
 * developer's dev-login preference. Only `ENOENT` licenses starting from `{}`.
 *
 * A value is never removed here. A name that leaves the registry leaves a line nothing reads; `pithy
 * doctor` is where a value nobody declares gets named, in this file exactly as in its neighbour.
 */
export async function writeBootstrapVars(
  projectDir: string,
  values: Record<string, string>,
  options: StatePathOptions = {},
): Promise<BootstrapVars> {
  const path = await bootstrapVarsPath(projectDir, options);
  if (path === null) return {};
  const document = await readDevJson(path);
  const merged: BootstrapVars = { ...((document[BOOTSTRAP_VARS_KEY] as BootstrapVars | undefined) ?? {}), ...values };
  if (Object.keys(values).length === 0) return merged;
  await ensureDevSecretsDir(path);
  await writeFileAtomic(path, `${JSON.stringify({ ...document, [BOOTSTRAP_VARS_KEY]: merged }, null, 2)}\n`, {
    mode: 0o600,
  });
  // Unconditionally and after the write, the same as the secrets file's: a `dev.json` an older pithy or an
  // editor created at the umask kept 0644 while holding the dev master key. Narrowing only.
  await tightenMode(path);
  return merged;
}

/**
 * Take names out of this project's bootstrap set — the teardown half, for a value whose resource no
 * longer exists. Returns the set that remains, so a caller regenerating from it never re-reads.
 *
 * A name that is not there is a no-op, and a project with no `dev.json` is not created one. Removing a
 * value here is what makes the next generation drop its line: the generated file is built from the
 * sources rather than edited, so there is no line to delete anywhere else.
 */
export async function removeBootstrapVars(
  projectDir: string,
  names: readonly string[],
  options: StatePathOptions = {},
): Promise<BootstrapVars> {
  const path = await bootstrapVarsPath(projectDir, options);
  if (path === null) return {};
  const document = await readDevJson(path);
  const current: BootstrapVars = (document[BOOTSTRAP_VARS_KEY] as BootstrapVars | undefined) ?? {};
  const remaining = Object.fromEntries(Object.entries(current).filter(([name]) => !names.includes(name)));
  if (Object.keys(remaining).length === Object.keys(current).length) return current;
  await ensureDevSecretsDir(path);
  await writeFileAtomic(path, `${JSON.stringify({ ...document, [BOOTSTRAP_VARS_KEY]: remaining }, null, 2)}\n`, {
    mode: 0o600,
  });
  await tightenMode(path);
  return remaining;
}

/**
 * The parsed `dev.json`, with every tenant's key intact. `{}` for an absent file and for one whose JSON
 * is not an object; a present file that will not read at all is the caller's refusal, not a fresh start.
 *
 * The `ENOENT`-only rule is {@link readOptionalFile}'s (`../project/`); the words below are this file's,
 * because "cannot update" is what a read-modify-write over somebody else's tenants has to say.
 */
async function readDevJson(path: string): Promise<Record<string, unknown>> {
  const source = await readOptionalFile(path, {
    unreadable: ({ code, cause }) =>
      new ConflictError(
        {
          message: `Cannot update ${path}: Pithy could not read what is already in it.`,
          action: "Fix the file's permissions, or move it aside, and run the command again.",
          detail: `${code ?? "unknown error"} while reading ${path}`,
        },
        { cause },
      ),
  });
  if (source === null) return {};
  const parsed = DevJson.safeParse(safeJson(source));
  return parsed.success ? parsed.data : {};
}

/** `JSON.parse` that answers `undefined` rather than throwing — this file is hand-edited. */
function safeJson(source: string): unknown {
  try {
    return JSON.parse(source);
  } catch {
    return undefined;
  }
}

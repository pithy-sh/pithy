// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ConflictError, InternalError } from "@pithy-sh/core/src/error/pithyError";
import { z } from "zod";
import { ensureOwnerOnlyDirFor } from "../../devSecrets/mode";
import { type StatePathOptions, stateDir } from "../../notifier/state";
import { writeFileAtomic } from "../../project/atomic";
import { withFileLock } from "../../project/fileLock";
import { readOptionalFile } from "../../project/readOptionalFile";
import { ancestors, bindingKeySync, checkoutRootSync } from "./checkout";
import { ProfileName } from "./store";

/**
 * **Which Cloudflare profile applies here: `<config>/profiles.json`, `0664` (#759).**
 *
 * Keyed by absolute directory → profile name, plus an optional default, which is the shape and the
 * posture `dev-ports.json` already has: a map of paths to names, holding nothing secret. The session
 * itself is `session.<profile>.json`, `0600`, beside it.
 *
 * **A profile is named, not per project.** One profile may be bound to several directories — a developer
 * with four repositories on one account signs in once. The binding is path-keyed because that is the
 * question being asked: *which credential applies to the command I just ran here.*
 *
 * **A binding on a repository covers its worktrees.** The key is the main checkout, the same key
 * `registryRootFor` files port blocks under, so `pithy feature create` never needs a second sign-in.
 */

export const ProfileBindings = z
  .object({
    default: ProfileName.optional().describe("The profile that applies where no directory is bound."),
    bindings: z
      .record(z.string(), ProfileName)
      .describe("Absolute directory → profile name. A repository is keyed by its main checkout."),
  })
  .describe("Which Cloudflare profile applies in which directory — <config>/profiles.json, mode 0664, no secrets.");

/** The bindings file's contents. Same name as its schema. */
export type ProfileBindings = z.output<typeof ProfileBindings>;

/** Where the profile that applies here came from. */
export interface BoundProfile {
  /** The profile name. */
  profile: string;
  /** `directory` when a binding matched; `default` when none did and the default stood in. */
  via: "directory" | "default";
  /** The directory whose binding matched, or `null` for the default. */
  key: string | null;
}

/** `<config>/profiles.json`. */
export function profilesPath(options: StatePathOptions = {}): string {
  return join(stateDir(options), "profiles.json");
}

/** The bindings, or none. Synchronous for the credential seam; a malformed file is no bindings. */
export function readBindingsSync(options: StatePathOptions = {}): ProfileBindings {
  try {
    const parsed = ProfileBindings.safeParse(JSON.parse(readFileSync(profilesPath(options), "utf8")));
    if (parsed.success) return parsed.data;
  } catch {
    // Absent or unreadable: nothing is bound. `pithy doctor` says so; no command stops over it.
  }
  return { bindings: {} };
}

/**
 * The profile that applies in `cwd`: the nearest bound directory above it — following a worktree to its
 * main checkout — and the default when none is bound. `null` when neither says anything.
 */
export function boundProfileSync(cwd: string, options: StatePathOptions = {}): BoundProfile | null {
  const file = readBindingsSync(options);
  for (const candidate of ancestors(cwd)) {
    const direct = file.bindings[candidate];
    if (direct !== undefined) return { profile: direct, via: "directory", key: candidate };
    const root = checkoutRootSync(candidate);
    if (root !== null && root !== candidate) {
      const viaRoot = file.bindings[root];
      if (viaRoot !== undefined) return { profile: viaRoot, via: "directory", key: root };
    }
  }
  return file.default === undefined ? null : { profile: file.default, via: "default", key: null };
}

/**
 * The bindings a writer starts from — **refusing a file that exists and will not open**, where
 * {@link readBindingsSync} answers it with none. Only absence licenses starting from nothing: writing over
 * an unreadable file would delete every other directory's binding to add one. A malformed document starts
 * from nothing, as `writeCloudflareConfig`'s does; it holds names, never a credential.
 */
async function readMergeBase(path: string): Promise<ProfileBindings> {
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
  if (source === null) return { bindings: {} };
  try {
    const parsed = ProfileBindings.safeParse(JSON.parse(source));
    return parsed.success ? parsed.data : { bindings: {} };
  } catch {
    return { bindings: {} };
  }
}

/** Read-modify-write the bindings under their lock. */
async function updateBindings<T>(
  options: StatePathOptions,
  change: (file: ProfileBindings) => { file: ProfileBindings; result: T },
): Promise<T> {
  const path = profilesPath(options);
  await ensureOwnerOnlyDirFor(path);
  return withFileLock(
    path,
    async () => {
      const { file, result } = change(await readMergeBase(path));
      await writeFileAtomic(path, `${JSON.stringify(ProfileBindings.parse(file), null, 2)}\n`, { mode: 0o664 });
      return result;
    },
    {
      refusal: ({ lockPath, attempts }) =>
        new InternalError({
          message: "Could not lock the Cloudflare profile bindings.",
          action: `If no other pithy process is running, delete ${lockPath} by hand and retry.`,
          detail: `Timed out acquiring ${lockPath} after ${attempts} attempts.`,
        }),
    },
  );
}

/** Bind `dir` — filed under {@link bindingKeySync} — to `profile`. Returns the key it was filed under. */
export async function bindProfile(dir: string, profile: string, options: StatePathOptions = {}): Promise<string> {
  const name = ProfileName.parse(profile);
  const key = bindingKeySync(dir);
  return updateBindings(options, (file) => ({
    file: { ...file, bindings: { ...file.bindings, [key]: name } },
    result: key,
  }));
}

/** Remove `dir`'s binding. `true` when there was one. */
export async function unbindProfile(dir: string, options: StatePathOptions = {}): Promise<boolean> {
  const key = bindingKeySync(dir);
  return updateBindings(options, (file) => {
    if (file.bindings[key] === undefined) return { file, result: false };
    const { [key]: _removed, ...rest } = file.bindings;
    return { file: { ...file, bindings: rest }, result: true };
  });
}

/**
 * Remove **the binding that applies in `cwd`** — the nearest bound directory above it, or the default — so
 * the directory resolves as if no profile were bound. Not the key `cwd` itself would file under: a binding
 * on a parent, or the default, is what a command run here actually uses. `null` when nothing applied.
 */
export async function unbindApplying(
  cwd: string,
  options: StatePathOptions = {},
): Promise<{ removed: "directory" | "default"; key: string | null } | null> {
  const applying = boundProfileSync(cwd, options);
  if (applying === null) return null;
  return updateBindings<{ removed: "directory" | "default"; key: string | null }>(options, (file) => {
    if (applying.via === "default") {
      const { default: _removed, ...rest } = file;
      return { file: rest, result: { removed: "default", key: null } };
    }
    const key = applying.key ?? "";
    const { [key]: _removed, ...bindings } = file.bindings;
    return { file: { ...file, bindings }, result: { removed: "directory", key } };
  });
}

/** Set the profile that applies where nothing is bound. */
export async function setDefaultProfile(profile: string, options: StatePathOptions = {}): Promise<void> {
  const name = ProfileName.parse(profile);
  await updateBindings(options, (file) => ({ file: { ...file, default: name }, result: undefined }));
}

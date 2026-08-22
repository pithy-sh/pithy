// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { readFile } from "node:fs/promises";
import { z } from "zod";
import type { StatePathOptions } from "../notifier/state";
import { loadProject, requireProjectName } from "../project/config";
import { devPreferencesPath } from "../seed/prepare";

/**
 * Whether this project has a dev-login preference file, and whether it says anything a seed can use.
 *
 * **Why a diagnostic owns this at all.** `dev.json` is machine-local, outside the repo, and named by
 * nothing in the checkout — so a developer whose dev login is not working has no file to grep for and no
 * command that will tell them where it should be. `pithy doctor` already reports one config directory; this
 * makes it report the one file inside it that is per project. See {@link describeDevPreferences} for the
 * line, and `docs/SEED.md` for what the file is.
 *
 * **It never claims the named user is seeded.** Doctor runs no seed, composes no sets, and opens no
 * database, so whether the email in the file is a user any run creates is a fact it has not established. The
 * seed already refuses loudly on an unknown user and lists the ones it does create — that is the check that
 * has the inventory, and this one stays quiet rather than guessing alongside it.
 */
export type DevPreferencesState =
  /**
   * No file. **The documented default, and never a fault.** "There is no way in but a magic link" is the
   * behavior auth ships, and opting out of it is a choice a developer makes per machine. Reported anyway,
   * because the path is the whole answer to "where do I put one".
   */
  | "absent"
  /** The file parses and names a user. Whether that user is seeded is the seed's question, not this one. */
  | "ok"
  /**
   * The file is there and is not JSON. **A fault, and the quiet kind doctor exists to name.**
   * `readDevPreferences` treats an unparseable file exactly like an absent one — deliberately, so a
   * half-typed preference cannot fail a whole seed run — which means a developer who typo'd their `dev.json`
   * gets no session, no error, and no clue. Nothing else in the toolchain will ever mention it.
   */
  | "unparseable"
  /**
   * The file parses and names no user. A fault too, though a louder one: `authDevSessionSeed` throws on it
   * the next time anyone seeds. Doctor says it first, offline, without a run.
   *
   * `user` is the only key any composed set reads today, so "names no user" and "says nothing usable" are
   * the same sentence. When a second set starts reading `dev.json`, this check has to widen with it — a file
   * written for that set would otherwise be reported as a fault by a check that had never heard of it.
   */
  | "no-user"
  /**
   * The check itself threw, so nothing about the file was established (#371).
   *
   * **Not `absent`.** That is the documented default and reads as "everything is as it should be", which
   * is the one thing this state must not say. It never fails the exit, on the same rule every other
   * establishes-nothing state in this report follows.
   */
  | "could-not-check";

/** What `doctor` learned about this project's dev-login preference file. */
export interface DevPreferencesCheck {
  state: DevPreferencesState;
  /**
   * The resolved absolute path — the same one `pithy seed` reads, on this platform. Always set, including
   * under `absent`: telling a developer where the file *would* go is most of what this check is for. The
   * text renderer abbreviates it against `$HOME`; `--json` carries it whole.
   */
  path: string;
  /** The email the file names, or `null` when it names none. Never asserted to be a user any run seeds. */
  user: string | null;
}

/**
 * The shape doctor reads out of `dev.json` — auth's `DevPreferences`, narrowed to the one question here.
 *
 * Restated rather than imported: `@pithy-sh/auth` is not a CLI dependency, and making it one so a
 * diagnostic could name a key would invert the dependency the whole capability model rests on. Held to the
 * same rule the file itself is — extra keys pass, because a `dev.json` carrying another set's preference is
 * a valid file, not a malformed one.
 */
const NamedUser = z
  .object({
    user: z
      .string()
      .min(1)
      .describe("The email `dev.json` names. Non-empty, because an empty string names nobody to sign in as."),
  })
  .describe("The one key a dev-login preference file must carry for any seed to do anything with it.");

/** The project name seed itself would resolve, or `null` when there is none to resolve. */
async function preferenceProject(projectDir: string): Promise<string | null> {
  try {
    // `requireProjectName` rather than `config.name`, because that is the exact call `pithy seed` makes —
    // kebabing included. Two resolutions would let doctor report a path seed never reads. It throws on an
    // absent name and on an illegal one, and both are `null` here: `checkProjectName` owns the illegal-name
    // verdict, and two blocks reporting one fault is how a report starts contradicting itself.
    return requireProjectName(await loadProject(projectDir));
  } catch {
    return null;
  }
}

/**
 * Resolve and read this project's `dev.json`.
 *
 * Never throws — a diagnostic has to work in the broken environment it exists to diagnose. `null` means the
 * question does not arise: no readable root config, or one with no usable `name`, so there is no per-project
 * path to resolve and nothing to report. The `Project:` block above it has already said which.
 */
export async function checkDevPreferences(
  projectDir: string,
  options: StatePathOptions = {},
): Promise<DevPreferencesCheck | null> {
  const project = await preferenceProject(projectDir);
  if (project === null) return null;

  const path = devPreferencesPath(project, options);
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch {
    return { state: "absent", path, user: null };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { state: "unparseable", path, user: null };
  }

  const named = NamedUser.safeParse(parsed);
  if (!named.success) return { state: "no-user", path, user: null };
  return { state: "ok", path, user: named.data.user };
}

/**
 * The verdict half of the `Dev login:` line — the path is the caller's to render, because the text report
 * abbreviates it against `$HOME` and `--json` does not.
 */
export function describeDevPreferences(check: DevPreferencesCheck): string {
  switch (check.state) {
    case "absent":
      return "none yet; sign-in stays magic-link only";
    // What the file says, and nothing about whether it is true. See {@link DevPreferencesState}.
    case "ok":
      return `names ${check.user}`;
    case "unparseable":
      return "will not parse; seed reads nothing from it";
    case "no-user":
      return 'no "user"; seed has nobody to sign in as';
    case "could-not-check":
      // Not "none yet". Nothing was read, so nothing is known — and the path is still the answer to the
      // question this line exists for.
      return "couldn't be checked";
  }
}

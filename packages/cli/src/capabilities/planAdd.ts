// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { writeFile } from "node:fs/promises";
import { basename, join, relative, sep } from "node:path";
import { PreconditionFailedError } from "@pithy-sh/core/src/error/pithyError";
import { emptyPlan, type Plan, type PlanFile, type PlanSecret } from "../plan/plan";
import { inShadow } from "../plan/shadow";
import { installDirFor, installedVersion } from "../project/installedPackage";
import { alreadyProvided, detectPackageManager, installArgs, type PackageManager } from "../project/packageManager";
import { readOptionalFile } from "../project/readOptionalFile";
import { workerIdentity } from "../project/workerIdentity";
import { planBootstrapAdd } from "./addBootstrap";
import { addAgain } from "./addCommand";
import { CATALOG } from "./catalog";
import { ejectCapability } from "./eject";
import { type AddResult, addRunCaller, type RunAddOptions, runAdd } from "./flow";

/**
 * **`pithy add --dry-run`: the real add, in a copy of the project.**
 *
 * The add is not described here. {@link runAdd} runs — the same prerequisite refusal, the same required
 * options, the same config, binding, entry, seam and manifest writes — against a private copy of the
 * project, and the plan is what it changed there. Only the steps that would reach past the project are
 * swapped for ones that say what they would do:
 *
 * - **the install** spawns nothing. It declares the package at `^<installed>` in the copy's `package.json` where
 *   the install would run — the Worker's, when it is a workspace member — so the declaration that follows reads the
 *   same range the real run reads, and names the command on that file when it changes the declaration there. A
 *   package already declared at that range is no edit, but the real install still runs and names no version, so
 *   a release newer than the installed one moves the declaration and the lockfile: the plan names that step and
 *   its condition rather than an edit with no diff, since a dry run reads no registry;
 * - **the migrate** opens no database. Which migrations are pending is known only once the wiring is on
 *   disk, so the plan says the step runs rather than guessing its list;
 * - **the bootstrap** mints nothing. {@link planBootstrapAdd} reads what it would mint;
 * - **the eject's dependency install** spawns nothing, and is named beside the install when it would change a
 *   declaration there ({@link redeclares});
 * - **the root install** that brings the lockfile in step with a root `devDependency` a test binding's import
 *   needs spawns nothing, and is named on the root `package.json`;
 * - **the audit** records nothing.
 *
 * **A plan names only the files the add would change.** A step whose run would leave a file as it is plans no
 * edit, so a re-run over a Worker that already composes the capability plans none, and says so through the
 * result's `alreadyWired`. The install is the one step whose outcome turns on the registry, so it is named as a
 * step with the condition under which it edits.
 *
 * **The manifest has to be installed.** It is what says what a capability wires, and installing it is the
 * one step a plan cannot make in a copy. It is found the way the real run finds it, from the Worker's
 * directory up to the root. A capability installed in neither is refused with the command that installs it,
 * rather than planned from a guess.
 */

/** What a dry run of `pithy add` returns: the add's own result, as it would be, and the plan. */
export type AddPlan = AddResult & { plan: Plan };

const toPosix = (path: string) => path.split(sep).join("/");

/**
 * Whether installing `specs`, each `<name>@<range>`, would change `declared`: an install writes the range it was
 * given, so a dependency already declared at that range is left as it is, and any other is an edit.
 */
export function redeclares(declared: Readonly<Record<string, string>>, specs: readonly string[]): boolean {
  return specs.some((spec) => {
    const at = spec.lastIndexOf("@");
    return declared[spec.slice(0, at)] !== spec.slice(at + 1);
  });
}

/**
 * Declare `pkg` in the `package.json` under `dir` in the copy at `^<installed>`, the range an install writes, in
 * name order — so the declaration that reads it back is planned from the same answer the real run reads. Returns
 * whether the file changed: an install of a package already declared there at that range leaves it as it is, and
 * one declared at any other range is rewritten to it.
 */
async function declareIn(dir: string, version: string, pkg: string): Promise<boolean> {
  const path = join(dir, "package.json");
  const raw = await readOptionalFile(path);
  if (raw === null) return false;
  const doc = JSON.parse(raw) as { dependencies?: Record<string, string> };
  if (doc.dependencies?.[pkg] === `^${version}`) return false;
  const dependencies = { ...(doc.dependencies ?? {}), [pkg]: `^${version}` };
  doc.dependencies = Object.fromEntries(Object.entries(dependencies).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
  await writeFile(path, `${JSON.stringify(doc, null, 2)}\n`);
  return true;
}

/**
 * The refusal for a capability whose manifest is not on disk to plan from. `again` is the caller's own dry run,
 * every flag and `--set` it was given carried over, so running it again plans what was asked. `installDir` is the
 * project-relative directory the real add installs in: a Worker's member is named, so following the command does
 * not declare the package at the root.
 */
function notInstalled(
  pkg: string,
  packageManager: PackageManager,
  again: string,
  installDir: string,
): PreconditionFailedError {
  const capability = CATALOG.find((entry) => entry.package === pkg)?.name ?? pkg;
  const install = [packageManager, ...installArgs(packageManager, pkg)].join(" ");
  return new PreconditionFailedError({
    message: `${pkg} is not installed, so there is no manifest to plan ${capability} from.`,
    action:
      installDir === ""
        ? `Install it with ${install}, then run ${again} again.`
        : `Install it with cd ${installDir} && ${install}, then run ${again} again from the project root.`,
  });
}

/** One entry per path, the given line added to its `changes` — an entry the copy produced, or a new one. */
function withChange(files: PlanFile[], path: string, change: string): PlanFile[] {
  const existing = files.find((file) => file.path === path);
  if (existing) {
    existing.changes.push(change);
    return files;
  }
  const added: PlanFile = { path, action: "edit", changes: [change] };
  return [...files, added].sort((a, b) => a.path.localeCompare(b.path));
}

/**
 * An ejected copy is one directory created, not a diff of every file in a package's source. The repointed
 * import and entry are edits of the adopter's own files, and keep theirs.
 */
function collapseEject(files: PlanFile[], dir: string, pkg: string): PlanFile[] {
  const inside = files.filter((file) => file.path.startsWith(`${dir}/`));
  if (inside.length === 0) return files;
  const entry: PlanFile = {
    path: dir,
    action: "create",
    changes: [`Copies ${pkg}'s source here, ${inside.length} files. ${pkg} no longer upgrades it.`],
  };
  return [...files.filter((file) => !file.path.startsWith(`${dir}/`)), entry].sort((a, b) =>
    a.path.localeCompare(b.path),
  );
}

/** Plan `pithy add` for `options`, writing nothing in the project and installing nothing. */
export async function planAdd(options: RunAddOptions): Promise<AddPlan> {
  const { projectDir, workerDir } = options;
  const worker = options.worker ?? basename(workerDir);
  const packageManager = await detectPackageManager(projectDir);
  const installDir = await installDirFor(projectDir, workerDir);
  const installs: string[] = [];
  const promoted: string[] = [];
  const secrets: PlanSecret[] = [];
  const steps = new Set<string>();
  let syncsRoot = false;
  const install = (packages: string[]) => [packageManager, ...installArgs(packageManager, packages)].join(" ");
  const installManifest = toPosix(relative(projectDir, join(installDir, "package.json")));

  const { result, files, notes } = await inShadow(projectDir, async (shadow) => {
    const added = await runAdd({
      ...options,
      dryRun: true,
      projectDir: shadow.root,
      workerDir: shadow.at(workerDir),
      worker,
      install: async ({ pkg }) => {
        const version = await installedVersion(projectDir, workerDir, pkg);
        if (version === null) {
          throw notInstalled(
            pkg,
            packageManager,
            addAgain(addRunCaller({ ...options, dryRun: true }), options),
            toPosix(relative(projectDir, installDir)),
          );
        }
        if (await alreadyProvided(projectDir, pkg, workerDir)) return { packageManager };
        if (await declareIn(shadow.at(installDir), version, pkg)) {
          installs.push(pkg);
        } else {
          steps.add(
            `Runs ${install([pkg])} for ${installManifest}. It leaves that file and the lockfile as they are while ${version} is the newest release of ${pkg}, and moves both to a newer one if it is out.`,
          );
        }
        return { packageManager };
      },
      sync: async () => {
        syncsRoot = true;
      },
      migrate: async () => {
        steps.add(`Then applies ${worker}'s pending dev migrations to the local database.`);
        return [];
      },
      ejectStep: (eject) =>
        ejectCapability({
          ...eject,
          promoteDeps: async (_dir, dependencies) => {
            const raw = await readOptionalFile(join(installDir, "package.json"));
            const declared =
              raw === null ? {} : ((JSON.parse(raw) as { dependencies?: Record<string, string> }).dependencies ?? {});
            if (redeclares(declared, dependencies)) promoted.push(...dependencies);
          },
        }),
      bootstrap: async ({ manifest, worker: named }) => {
        const planned = await planBootstrapAdd({
          projectDir,
          manifest,
          worker: named,
          productionEnvironments: options.productionEnvironments ?? [],
        });
        secrets.push(...planned.secrets);
        for (const step of planned.steps) steps.add(step);
        return planned.notes;
      },
      audit: async () => {},
    });
    return { ...added, notes: added.notes.map((note) => shadow.toProject(note)) };
  });

  let planned = files;
  if (result.eject) {
    planned = collapseEject(planned, toPosix(relative(projectDir, join(workerDir, result.eject.path))), result.package);
  }
  if (installs.length > 0) {
    planned = withChange(planned, installManifest, `Runs ${install(installs)} here, which also writes the lockfile.`);
  }
  if (syncsRoot) {
    planned = withChange(
      planned,
      "package.json",
      `Runs ${packageManager} install here, which also writes the lockfile.`,
    );
  }
  if (promoted.length > 0) {
    planned = withChange(planned, installManifest, `Runs ${install(promoted)} here, for the ejected copy.`);
  }

  return {
    ...result,
    ...workerIdentity({ name: worker, dir: workerDir }),
    plan: { ...emptyPlan(), files: planned, secrets, notes: [...steps, ...notes] },
  };
}

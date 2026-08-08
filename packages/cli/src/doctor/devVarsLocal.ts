// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { relative } from "node:path";
import { DEV_VARS_LOCAL, readLocalOverrides } from "../devSecrets/generate";
import { type DevSecretsTarget, resolveDevSecretsTargets, type UnresolvableWorker } from "../devSecrets/targets";
import { discoverWorkers } from "../project/workers";
import { declaredVars } from "./wranglerVars";

/**
 * What is in a `.dev.vars.local` that nothing else in the project knows about — the footgun `.local`
 * creates, made visible (#154).
 *
 * `.dev.vars.local` is for **overrides**, not for variables. Overriding a generated value locally, or
 * shadowing a secret for an afternoon, is exactly what it is for. But a variable that exists *only*
 * there works in dev and is simply absent in production, and that failure lands at deploy — far from the
 * cause, in a file the deploy never reads and git never showed anyone. Anything an adopter wants to
 * exist belongs in `wrangler.jsonc`'s `vars`: committed, reviewed, and deployed with the Worker.
 *
 * **Visible, not forbidden.** Neither finding fails the exit. A shadowing override is legitimate and
 * common; a dev-only variable is sometimes genuinely dev-only. What is not acceptable is that either be
 * invisible, which is what a git-ignored file is by construction.
 *
 * **What counts as declared is {@link declaredVars}'s to say**, and it is shared with the root
 * `.dev.vars` check next door — `env.<name>.vars` *replaces* the top-level block rather than merging it,
 * so a key counts if it appears at the top level **or** in any environment. Reading only the top level
 * names a staging-only variable as dev-only, and reading only one environment names every ordinary
 * variable. Two checks asking the same question, through one function, so only one can be half-right.
 */

/** One `.dev.vars.local` key with nothing behind it, and where it was written. */
export interface DevOnlyVar {
  /** The variable name, as the adopter wrote it. Never its value. */
  key: string;
  /** The `.dev.vars.local` it is in, relative to the project root — root's, or a Worker's. */
  file: string;
}

/** What doctor learned about this project's `.dev.vars.local` files. */
export interface DevVarsLocalCheck {
  /**
   * Keys that are neither a registry secret nor declared in any `wrangler.jsonc` `vars` block. They
   * exist in dev and nowhere else. Sorted by file, then key.
   *
   * **Empty whenever anything is {@link DevVarsLocalCheck.unresolvable}** (#208). "Nowhere else knows
   * about this key" is a negative claim, and a registry that would not load is exactly what might have
   * known. Saying it anyway is how an adopter is told a declared secret is dev-only.
   */
  devOnly: DevOnlyVar[];
  /**
   * Keys that shadow a registry secret. Legitimate — that is what the file is for — and never invisible:
   * a Worker running on a value that is not the one the secrets file states is a fact worth one line.
   */
  shadowing: DevOnlyVar[];
  /**
   * Every Worker with a `pithy.config.ts` that would not import, and why (#208). Empty on an ordinary run.
   *
   * The sentence naming it belongs to `./devVars`, which prints first in the same `Dev secrets:` block;
   * this field is what stops this check from making a claim about a registry it never read.
   */
  unresolvable: UnresolvableWorker[];
}

/** What {@link checkDevVarsLocal} needs. Every seam defaults to the real project. */
export interface CheckDevVarsLocalOptions {
  /** The project root — owner of the root `.dev.vars.local` and of `apps/`. */
  projectDir: string;
  /** The Workers whose registries declare the secrets. Defaults to every one composing `secrets`. */
  targets?: DevSecretsTarget[];
  /**
   * The Workers whose `pithy.config.ts` would not import. Read only when {@link targets} is supplied —
   * both halves of one resolution, so a seam cannot state one and let the other default to a lie.
   */
  unresolvable?: UnresolvableWorker[];
  /** The Worker directories to look in. Defaults to every discovered Worker. */
  workerDirs?: string[];
}

/**
 * Read both scopes and judge each key against the registry and against `wrangler.jsonc`. Never throws — a
 * diagnostic has to work in the broken environment it exists to diagnose. `null` when there is nothing to
 * say, which is every project with no `.dev.vars.local` anywhere: the overwhelming majority.
 */
export async function checkDevVarsLocal(options: CheckDevVarsLocalOptions): Promise<DevVarsLocalCheck | null> {
  const workerDirs =
    options.workerDirs ?? (await discoverWorkers(options.projectDir).catch(() => [])).map((w) => w.dir);
  // Both halves of one resolution (#208) — the lossy wrapper's `.catch(() => [])` stood here and read a
  // config that would not import as a Worker that declares nothing.
  const { targets, unresolvable } =
    options.targets === undefined
      ? await resolveDevSecretsTargets(options.projectDir)
      : { targets: options.targets, unresolvable: options.unresolvable ?? [] };
  const declaredSecrets = new Set(targets.flatMap((target) => Object.keys(target.registry)));

  const devOnly: DevOnlyVar[] = [];
  const shadowing: DevOnlyVar[] = [];
  // The root file applies to every Worker, so its keys are judged against the union of every Worker's
  // `vars`: a key declared by the one Worker that needs it is not a dev-only variable.
  const everyVars = new Set<string>();
  const perWorker = new Map<string, Set<string>>();
  for (const dir of workerDirs) {
    const vars = await declaredVars(dir);
    perWorker.set(dir, vars);
    for (const key of vars) everyVars.add(key);
  }

  const scopes: { dir: string; declared: Set<string> }[] = [
    { dir: options.projectDir, declared: everyVars },
    ...workerDirs.map((dir) => ({ dir, declared: perWorker.get(dir) ?? new Set<string>() })),
  ];
  for (const scope of scopes) {
    const at = relative(options.projectDir, scope.dir);
    const file = at === "" ? DEV_VARS_LOCAL : `${at}/${DEV_VARS_LOCAL}`;
    for (const key of Object.keys(await readLocalOverrides(scope.dir).catch(() => ({}))).sort()) {
      if (declaredSecrets.has(key)) shadowing.push({ key, file });
      // The negative claim, and the one a partial resolution cannot support. Withheld rather than
      // hedged: `doctor` already says "this Worker's config would not import" once, in this same block,
      // and saying it again in other words per key is the noise `unreadable` next door avoids too.
      else if (!scope.declared.has(key) && unresolvable.length === 0) devOnly.push({ key, file });
    }
  }
  if (devOnly.length === 0 && shadowing.length === 0 && unresolvable.length === 0) return null;
  return { devOnly, shadowing, unresolvable };
}

/** The lines the report prints. Both findings are worth ink and neither is worth failing an exit over. */
export function describeDevVarsLocal(check: DevVarsLocalCheck): string[] {
  const lines: string[] = [];
  for (const { key, file } of check.devOnly) {
    lines.push(
      `${key} is in ${file} and nowhere else — it exists only in dev. A value production needs belongs in wrangler.jsonc vars.`,
    );
  }
  for (const { key, file } of check.shadowing) {
    lines.push(`${key} in ${file} shadows the secret of that name. Fine, and never silent.`);
  }
  return lines;
}

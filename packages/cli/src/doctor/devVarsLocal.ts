// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { relative } from "node:path";
import { DEV_VARS_LOCAL, readLocalOverrides } from "../devSecrets/generate";
import { type DevSecretsTarget, resolveDevSecretsTargets, type UnresolvableWorker } from "../devSecrets/targets";
import { discoverWorkers } from "../project/workers";
import { bindingSecrets } from "../provision/secretBindings";
import { declaredBindings, declaredVars } from "./wranglerVars";

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
 * **Visible, not forbidden.** No finding fails the exit. A shadowing override is legitimate and
 * common; a dev-only variable is sometimes genuinely dev-only. What is not acceptable is that either be
 * invisible, which is what a git-ignored file is by construction.
 *
 * **A key named like a binding is neither, and is never legitimate (#636).** It shadows the binding in
 * dev: `env.EMAIL_SENDER` is a string there and a Workflow everywhere else. Promoting it to `vars`, which
 * this check used to advise for every unexplained key, would shadow it in production too. So it is its own
 * finding, and its line says remove it. It still does not fail the exit — the rule above holds — but it
 * does not read as optional.
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

/** One `.dev.vars.local` key named like a binding its Worker declares, and the kind of that binding. */
export interface ShadowedBinding extends DevOnlyVar {
  /** The `wrangler.jsonc` key the binding is declared under — `workflows`, `d1_databases`, `durable_objects`. */
  kind: string;
}

/** What doctor learned about this project's `.dev.vars.local` files. */
export interface DevVarsLocalCheck {
  /**
   * Keys that are not a registry secret, not a binding, and not declared in any `wrangler.jsonc` `vars` block. They
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
   * Keys named like a binding the Worker's `wrangler.jsonc` declares, at the top level or in any
   * `env.<name>` (#636). Never legitimate: in dev the Worker reads a string where the binding should be.
   * The root file is judged against every Worker's bindings. Sorted by file, then key.
   *
   * A registry secret wins over its own `secrets_store_secrets` binding — that is {@link shadowing}. So
   * with anything {@link DevVarsLocalCheck.unresolvable}, a store-secret binding is withheld: the registry
   * nobody read may declare it (#208).
   */
  shadowingBinding: ShadowedBinding[];
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
  // Under its key, or — for a store secret — under the binding it is materialized and read as (#603).
  const declaredSecrets = new Set(
    targets.flatMap((target) => [...Object.keys(target.registry), ...bindingSecrets(target.registry).keys()]),
  );

  const devOnly: DevOnlyVar[] = [];
  const shadowing: DevOnlyVar[] = [];
  const shadowingBinding: ShadowedBinding[] = [];
  // The root file applies to every Worker, so its keys are judged against the union of every Worker's
  // `vars` and bindings: a key declared by the one Worker that needs it is declared.
  const everyVars = new Set<string>();
  const everyBinding = new Map<string, string>();
  const perWorker = new Map<string, { vars: Set<string>; bindings: Map<string, string> }>();
  for (const dir of workerDirs) {
    const vars = await declaredVars(dir);
    const bindings = await declaredBindings(dir);
    perWorker.set(dir, { vars, bindings });
    for (const key of vars) everyVars.add(key);
    for (const [name, kind] of bindings) if (!everyBinding.has(name)) everyBinding.set(name, kind);
  }

  const scopes: { dir: string; vars: Set<string>; bindings: Map<string, string> }[] = [
    { dir: options.projectDir, vars: everyVars, bindings: everyBinding },
    ...workerDirs.map((dir) => ({
      dir,
      vars: perWorker.get(dir)?.vars ?? new Set<string>(),
      bindings: perWorker.get(dir)?.bindings ?? new Map<string, string>(),
    })),
  ];
  for (const scope of scopes) {
    const at = relative(options.projectDir, scope.dir);
    const file = at === "" ? DEV_VARS_LOCAL : `${at}/${DEV_VARS_LOCAL}`;
    for (const key of Object.keys(await readLocalOverrides(scope.dir).catch(() => ({}))).sort()) {
      const kind = scope.bindings.get(key);
      if (declaredSecrets.has(key)) shadowing.push({ key, file });
      // Positive evidence from `wrangler.jsonc`, so it survives a registry nobody read — except a store
      // secret's binding, which that registry may declare as the secret it is.
      else if (kind !== undefined) {
        if (kind !== "secrets_store_secrets" || unresolvable.length === 0) shadowingBinding.push({ key, file, kind });
      }
      // The negative claim, and the one a partial resolution cannot support. Withheld rather than
      // hedged: `doctor` already says "this Worker's config would not import" once, in this same block,
      // and saying it again in other words per key is the noise `unreadable` next door avoids too.
      else if (!scope.vars.has(key) && unresolvable.length === 0) devOnly.push({ key, file });
    }
  }
  if (devOnly.length === 0 && shadowing.length === 0 && shadowingBinding.length === 0 && unresolvable.length === 0)
    return null;
  return { devOnly, shadowing, shadowingBinding, unresolvable };
}

/**
 * The lines the report prints. Every finding is worth ink and none is worth failing an exit over.
 *
 * The dev-only line gives both outcomes because doctor cannot know which is true: whether production needs
 * a variable is the adopter's fact, and a dead key promoted to `vars` deploys as a plaintext variable.
 */
export function describeDevVarsLocal(check: DevVarsLocalCheck): string[] {
  const lines: string[] = [];
  for (const { key, file, kind } of check.shadowingBinding) {
    lines.push(
      `${key} in ${file} shadows the ${kind} binding of that name. In dev the Worker reads a string where the binding should be. Remove it.`,
    );
  }
  for (const { key, file } of check.devOnly) {
    lines.push(
      `${key} is in ${file} and nowhere else. If production needs it, declare it in wrangler.jsonc vars. If nothing reads it, delete it.`,
    );
  }
  for (const { key, file } of check.shadowing) {
    lines.push(`${key} in ${file} shadows the secret of that name. Fine, and never silent.`);
  }
  return lines;
}

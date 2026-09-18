// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { basename, relative } from "node:path";
import { DEV_VARS_LOCAL, readLocalOverrides } from "../devSecrets/generate";
import { type DevSecretsTarget, resolveDevSecretsTargets, type UnresolvableWorker } from "../devSecrets/targets";
import { discoverWorkers } from "../project/workers";
import { bindingSecrets } from "../provision/secretBindings";
import { type DeclaredBinding, declaredBindings, declaredRequiredSecrets, declaredVars } from "./wranglerVars";

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
 * **A key named like a binding is neither, and is never legitimate (#636).** `wrangler dev` hands a
 * `.dev.vars` value to the Worker only where no binding of that name exists: for a binding the top level
 * declares, the binding wins and the value is ignored. For one declared only in an `env.<name>` or in
 * `previews`, the top level `pithy dev` runs has no such binding, so the Worker reads the string there and
 * the binding everywhere else. Either way the key is wrong, and promoting it to `vars` — which this check
 * used to advise for every unexplained key — is a config wrangler refuses to load. So it is its own
 * finding, and its line says remove it, or, in the root file, move it to the Workers that read it as a
 * value. It still does not fail the exit — the rule above holds — but it does not read as optional.
 *
 * **Judged per Worker.** A Worker's own file is judged against that Worker's secrets — its registry, and
 * wrangler's `secrets.required` — its bindings and its `vars`. A sibling's registry secret is reached only
 * after all of them: every registry's secrets reach every generated `.dev.vars`, so overriding one is
 * shadowing it, but it never hides this Worker's own binding. The root file reaches every Worker, so it is
 * judged against each, and the verdicts are combined: any Worker binding the name makes it a binding
 * finding naming each such Worker; the Workers reading it as a secret or a var are where it moves.
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

/** One Worker's binding of a name, and where it is declared. */
export interface BindingOwner extends DeclaredBinding {
  /** The Worker, by its `apps/<name>` directory — the name its file path shows. */
  worker: string;
}

/** One `.dev.vars.local` key named like a binding, the Workers that bind it, and where it belongs instead. */
export interface ShadowedBinding extends DevOnlyVar {
  /** Every Worker the file reaches that binds this name. One for a Worker's own file. Sorted by Worker. */
  bindings: BindingOwner[];
  /**
   * The `.dev.vars.local` files of the Workers that read the name as a value — their own secret, or a
   * `vars` entry. Only ever set for the root file, which reaches them and the binders alike: the value is
   * real for them, so the line says move it rather than remove it. Sorted.
   */
  moveTo: string[];
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
   * Keys that shadow a secret — a registry's, or a name wrangler's `secrets.required` lists. Legitimate — that is what the file is for — and never invisible:
   * a Worker running on a value that is not the one the secrets file states is a fact worth one line.
   */
  shadowing: DevOnlyVar[];
  /**
   * Keys named like a binding the Worker's `wrangler.jsonc` declares, at the top level, in any `env.<name>`,
   * or in `previews` (#636). Never legitimate: at the top level wrangler dev ignores the value, and anywhere
   * else dev reads a string where the binding should be. The root file names every Worker it binds in.
   * Sorted by file, then key.
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
  // Every registry's secrets reach every generated `.dev.vars`, so overriding one anywhere is shadowing it.
  const projectSecrets = new Set(
    targets.flatMap((target) => [...Object.keys(target.registry), ...bindingSecrets(target.registry).keys()]),
  );
  const partial = unresolvable.length > 0;
  const workers: WorkerDeclarations[] = [];
  for (const dir of workerDirs) {
    const own = targets.filter((target) => target.dir === dir);
    workers.push({
      dir,
      name: basename(dir),
      file: `${relative(options.projectDir, dir)}/${DEV_VARS_LOCAL}`,
      // Under its key, or — for a store secret — under the binding it is materialized and read as (#603),
      // or under the name wrangler's own `secrets.required` gives it.
      secrets: new Set([
        ...own.flatMap((target) => [...Object.keys(target.registry), ...bindingSecrets(target.registry).keys()]),
        ...(await declaredRequiredSecrets(dir)),
      ]),
      vars: await declaredVars(dir),
      bindings: await declaredBindings(dir),
    });
  }

  const devOnly: DevOnlyVar[] = [];
  const shadowing: DevOnlyVar[] = [];
  const shadowingBinding: ShadowedBinding[] = [];
  const scopes = [
    { dir: options.projectDir, file: DEV_VARS_LOCAL, reaches: workers },
    ...workers.map((worker) => ({ dir: worker.dir, file: worker.file, reaches: [worker] })),
  ];
  for (const scope of scopes) {
    for (const key of Object.keys(await readLocalOverrides(scope.dir).catch(() => ({}))).sort()) {
      const verdicts = scope.reaches.map((worker) => ({
        worker,
        verdict: judge(key, worker, projectSecrets, partial),
      }));
      const bindings: BindingOwner[] = [];
      for (const { worker, verdict } of verdicts) {
        if (verdict.is === "binding") bindings.push({ worker: worker.name, ...verdict.binding });
      }
      const at = { key, file: scope.file };
      if (bindings.length > 0) {
        const moveTo = verdicts
          .filter(({ verdict }) => verdict.is === "own-secret" || verdict.is === "var")
          .map(({ worker }) => worker.file);
        shadowingBinding.push({ ...at, bindings: bindings.sort(byWorker), moveTo: moveTo.sort() });
      } else if (verdicts.some(({ verdict }) => verdict.is === "own-secret" || verdict.is === "project-secret"))
        shadowing.push(at);
      else if (verdicts.some(({ verdict }) => verdict.is === "var" || verdict.is === "withheld")) continue;
      // The negative claim, and the one a partial resolution cannot support. Withheld rather than
      // hedged: `doctor` already says "this Worker's config would not import" once, in this same block,
      // and saying it again in other words per key is the noise `unreadable` next door avoids too.
      // A root file with no Worker to reach is judged against the project's secrets alone.
      else if (scope.reaches.length === 0 && projectSecrets.has(key)) shadowing.push(at);
      else if (!partial) devOnly.push(at);
    }
  }
  if (devOnly.length === 0 && shadowing.length === 0 && shadowingBinding.length === 0 && unresolvable.length === 0)
    return null;
  return { devOnly, shadowing, shadowingBinding, unresolvable };
}

/** What one Worker's `wrangler.jsonc` and registry declare — everything a key is judged against. */
interface WorkerDeclarations {
  dir: string;
  /** Its `apps/<name>` directory's name — what its file path shows. */
  name: string;
  /** Its `.dev.vars.local`, relative to the project root. */
  file: string;
  /** Its own secrets: its registry's names, their store bindings, and wrangler's `secrets.required`. */
  secrets: Set<string>;
  vars: Set<string>;
  bindings: Map<string, DeclaredBinding>;
}

/** What one key is to one Worker. */
type Verdict =
  | { is: "own-secret" | "var" | "project-secret" | "withheld" | "nothing" }
  | { is: "binding"; binding: DeclaredBinding };

/**
 * One key against one Worker, in precedence order. The Worker's own declarations come first, and a
 * sibling's registry secret last, so it can never hide this Worker's binding (#636).
 *
 * 1. Its own secret. A store secret's binding is that secret (#603), and `secrets.required` names one.
 * 2. A binding at the top level — the stanza `wrangler dev` applies.
 * 3. A `vars` entry, anywhere: overriding one locally is what the file is for.
 * 4. A binding only an environment or `previews` declares.
 * 5. Any registry's secret, which reaches this Worker's generated `.dev.vars` too.
 *
 * Every binding verdict rests on `wrangler.jsonc`, so it survives a registry nobody read — except a store
 * secret's binding, which that registry may declare as the secret it is (#208). That one is withheld.
 */
function judge(key: string, worker: WorkerDeclarations, projectSecrets: Set<string>, partial: boolean): Verdict {
  if (worker.secrets.has(key)) return { is: "own-secret" };
  const binding = worker.bindings.get(key);
  const bound = binding !== undefined && !(binding.kind === "secrets_store_secrets" && partial);
  if (bound && binding.in === null) return { is: "binding", binding };
  if (worker.vars.has(key)) return { is: "var" };
  if (bound) return { is: "binding", binding };
  if (projectSecrets.has(key)) return { is: "project-secret" };
  return { is: binding === undefined ? "nothing" : "withheld" };
}

function byWorker(a: BindingOwner, b: BindingOwner): number {
  return a.worker.localeCompare(b.worker);
}

/**
 * The lines the report prints. Every finding is worth ink and none is worth failing an exit over.
 *
 * The dev-only line gives both outcomes because doctor cannot know which is true: whether production needs
 * a variable is the adopter's fact, and a dead key promoted to `vars` deploys as a plaintext variable.
 */
export function describeDevVarsLocal(check: DevVarsLocalCheck): string[] {
  const lines: string[] = [];
  for (const entry of check.shadowingBinding) lines.push(describeShadowedBinding(entry));
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

/**
 * One binding line. What `wrangler dev` does with the value decides the middle sentence, because it differs
 * by stanza: a top-level binding wins and the value is ignored; a binding the top level lacks leaves the
 * string in its place. What the root file reaches decides the last: remove it, or move it to the Workers
 * that read it as a value.
 */
function describeShadowedBinding({ key, file, bindings, moveTo }: ShadowedBinding): string {
  const named = bindings
    .map(({ worker, kind, in: at }) => `${worker}'s ${kind} binding${at === null ? "" : ` in ${at}`}`)
    .join(", ");
  const top = bindings.filter((binding) => binding.in === null).length;
  const effect =
    top === bindings.length
      ? "wrangler dev ignores the value: the binding wins."
      : top === 0
        ? "pithy dev runs the top level, which has no such binding, so in dev the Worker reads this string instead."
        : "wrangler dev ignores the value where the binding is at the top level, and hands the string over where it is not.";
  const readers = moveTo.map((path) => basename(path.slice(0, -DEV_VARS_LOCAL.length - 1)));
  const advice =
    moveTo.length === 0
      ? "Remove it."
      : `${readers.join(", ")} ${readers.length === 1 ? "reads" : "read"} it as a value: move it into ${moveTo.join(", ")}.`;
  return `${key} in ${file} has the name of ${named}. ${effect} ${advice}`;
}

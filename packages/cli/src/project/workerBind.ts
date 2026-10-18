// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { basename, join } from "node:path";
import type { BindingSpec } from "@pithy-sh/core/src/capability/bindings";
import { commandName, workerDirOf } from "@pithy-sh/core/src/cli/command";
import { ConflictError, NotFoundError, PithyError, ValidationError } from "@pithy-sh/core/src/error/pithyError";
import { LOCAL_ENVIRONMENT } from "@pithy-sh/core/src/naming/environment";
import { addAction, addPlan, projectAddFacts } from "../capabilities/addCommand";
import { HOST_WORKERS, hostWorkerFor } from "../capabilities/hostRegistry";
import { writeFileAtomic } from "./atomic";
import { composeFor } from "./composeFor";
import {
  allCapabilities,
  BindingName,
  type LoadWorkerConfigOptions,
  loadProject,
  requireProjectName,
  type WorkerConfig,
} from "./config";
import {
  addServiceBinding,
  declaredServiceBindings,
  removeServiceBinding,
  renderServiceBinding,
  type ServiceDeclaration,
} from "./configBindingSource";
import { readOptionalFile } from "./readOptionalFile";
import {
  bindingKindPhrase,
  closesLoop,
  defaultServiceBinding,
  loopSentence,
  renderPath,
  type ServiceEdge,
} from "./serviceGraph";
import { reconcileServiceStanzas, type ServiceWorkerNames, serviceScripts } from "./serviceStanzas";
import { discoverWorkers as discoverWorkersDefault, type WorkerTarget } from "./workers";

/**
 * **`pithy worker bind` and `unbind`: an app declares a service binding to another Worker of its project (#617).**
 *
 * The declaration lives in the binding app's own `pithy.config.ts`, as an entry in its app capability's
 * `requiredBindings` — the shape a capability's service binding already has, so provisioning, `worker sync`,
 * `doctor` and `dev` read it the way they read any other. These two commands write and remove that entry, refuse
 * every binding that cannot work, and write its `services` entry into each stanza of the app's `wrangler.jsonc`.
 */

/** What a target is: another `apps/` Worker, or a kit Worker named by its capability. */
export type ServiceTargetKind = "app" | "kit";

/** One Worker of the project, with what it declares. */
export interface ServiceWorker extends ServiceWorkerNames {
  /**
   * Every binding its capabilities declare, the app's included, or `null` when its config would not load — a
   * binding name is checked for a clash against this.
   */
  bindings: BindingSpec[] | null;
  /** The service bindings its own app declares: from the loaded config, or from the source when that failed. */
  services: ServiceDeclaration[];
  /** The capabilities it composes, by name. Empty when its config would not load. */
  capabilities: string[];
  /** Why its config would not load, when it would not. */
  loadError?: unknown;
}

/** The project as `bind` reasons about it: its Workers, the kit Workers it composes, and every declared edge. */
export interface ServiceProject {
  workers: ServiceWorker[];
  /** Every kit Worker some Worker of the project composes — and so the only kit Workers deployed. */
  kit: string[];
  /** Every service binding each Worker's app declares. */
  edges: ServiceEdge[];
}

/** The seams every reader here takes, so a test fixes the Worker set and its configs. */
export interface ServiceProjectOptions {
  projectDir: string;
  discoverWorkers?: (projectDir: string) => Promise<WorkerTarget[]>;
  loadConfig?: (workerDir: string, options?: LoadWorkerConfigOptions) => Promise<WorkerConfig>;
}

/** The service bindings an app capability declares. */
function appServices(config: WorkerConfig): ServiceDeclaration[] {
  return (config.app?.requiredBindings ?? []).flatMap((binding) =>
    binding.type === "service" && binding.service !== undefined
      ? [{ binding: binding.name, target: binding.service }]
      : [],
  );
}

/** A config's literal service declarations, read off the file, for a Worker whose config would not load. */
async function sourceServices(dir: string): Promise<ServiceDeclaration[]> {
  const source = await readOptionalFile(join(dir, "pithy.config.ts"));
  return source === null ? [] : declaredServiceBindings(source);
}

/**
 * Every Worker under `apps/` with what it declares, composed for `dev`. A Worker whose config will not load is
 * still listed — it can still be bound, and its literal declarations still count — with the reason kept, so the
 * one command that needs its config can refuse with it.
 */
export async function readServiceProject(options: ServiceProjectOptions): Promise<ServiceProject> {
  const targets = (await (options.discoverWorkers ?? discoverWorkersDefault)(options.projectDir)).filter(
    (worker) => worker.hasWrangler !== false,
  );
  const workers = await composeFor(LOCAL_ENVIRONMENT, async (load) => {
    const read = options.loadConfig ?? load;
    const found: ServiceWorker[] = [];
    for (const target of targets) {
      const names = { app: basename(target.dir), dir: target.dir, deployedAs: target.name };
      try {
        // Fresh: `bind` writes this file and `unbind` may read it back in the same process.
        const config = await read(target.dir, { fresh: true });
        const capabilities = allCapabilities(config);
        found.push({
          ...names,
          bindings: capabilities.flatMap((capability) => capability.requiredBindings),
          services: appServices(config),
          capabilities: capabilities.map((capability) => capability.name),
        });
      } catch (error) {
        // No `pithy.config.ts` at all is a Worker with nothing declared. Anything else is a config that broke.
        const missing = error instanceof PithyError && error.payload.code === "core/not_found";
        found.push({
          ...names,
          bindings: missing ? [] : null,
          services: missing ? [] : await sourceServices(target.dir),
          capabilities: [],
          ...(missing ? {} : { loadError: error }),
        });
      }
    }
    return found;
  });
  const composed = new Set(workers.flatMap((worker) => worker.capabilities));
  return {
    workers,
    kit: HOST_WORKERS.map((spec) => spec.capability).filter((capability) => composed.has(capability)),
    edges: workers.flatMap((worker) =>
      worker.services.map((service) => ({ from: worker.app, binding: service.binding, to: service.target })),
    ),
  };
}

/** The `apps/` Worker a name means — its directory name or its deploy name — or `undefined`. */
function appWorker(project: ServiceProject, name: string): ServiceWorker | undefined {
  return project.workers.find((worker) => worker.app === name || worker.deployedAs === name);
}

/** Every Worker `from` may bind: the other `apps/` Workers, then the kit Workers the project composes. */
export function bindableFrom(project: ServiceProject, from: string): string[] {
  return [...project.workers.map((worker) => worker.app).filter((app) => app !== from), ...project.kit];
}

/** The `apps/` Worker `--from` names. A kit Worker is refused: a binding is held by the adopter's own Worker. */
export function resolveBinder(project: ServiceProject, from: string): ServiceWorker {
  const found = appWorker(project, from);
  if (found) return found;
  const apps = project.workers.map((worker) => worker.app).join(", ") || "none";
  if (hostWorkerFor(from)) {
    throw new ValidationError({
      message: `${from} is a kit Worker. A binding is held by one of your apps/ Workers.`,
      action: `Pass an apps/ Worker as --from: ${apps}.`,
    });
  }
  throw new ValidationError({
    message: `No Worker named ${from} under apps/.`,
    action: `Pass an apps/ Worker as --from: ${apps}.`,
  });
}

/** What `--to` resolves to: the name a binding declares it by, and which kind of Worker it is. */
export interface ResolvedTarget {
  name: string;
  kind: ServiceTargetKind;
}

/** The Worker `--to` names, from `from`'s side: never itself, and a kit Worker only when its host is composed. */
export function resolveBindTarget(
  project: ServiceProject,
  from: ServiceWorker,
  to: string,
  projectDir: string,
): ResolvedTarget {
  const app = appWorker(project, to);
  if (app?.app === from.app) {
    throw new ValidationError({
      message: "A Worker does not bind itself here.",
      action:
        "Declare `administersItself: true` in the root pithy.config.ts instead. Provision then binds SELF in every environment (#616).",
    });
  }
  if (app) return { name: app.app, kind: "app" };
  if (hostWorkerFor(to)) {
    if (project.kit.includes(to)) return { name: to, kind: "kit" };
    throw new NotFoundError({
      message: `No Worker in this project composes ${to}, so there is no ${to} Worker to bind.`,
      action: addAction(
        addPlan({
          capability: to,
          workers: [workerDirOf(from)],
          factsFor: projectAddFacts(projectDir),
          composed: new Set(from.capabilities),
        }),
        (add) => `Run ${add} first.`,
      ),
    });
  }
  throw new ValidationError({
    message: `No Worker named ${to}.`,
    action: `Bindable: ${bindableFrom(project, from.app).join(", ") || "none"}.`,
  });
}

/** What `bind` and `unbind` report. `to` and `kind` are `null` only for an `unbind --binding` that found nothing. */
export interface ServiceBindReport {
  from: string;
  to: string | null;
  binding: string;
  kind: ServiceTargetKind | null;
  changed: boolean;
}

/** Options for {@link bindWorker}. */
export interface BindWorkerOptions extends ServiceProjectOptions {
  from: string;
  to: string;
  /** The binding name. Defaults to `to` in upper snake case. */
  binding?: string;
}

/** The binder's config, or the reason it would not load, thrown. `bind` and `unbind` both edit it. */
function requireLoaded(worker: ServiceWorker): BindingSpec[] {
  if (worker.bindings !== null) return worker.bindings;
  throw worker.loadError instanceof PithyError
    ? worker.loadError
    : new ValidationError({
        message: `apps/${worker.app}/pithy.config.ts would not load, so its bindings cannot be checked.`,
        action: "Fix the file, then run this again.",
      });
}

/** Rewrite the binder's `pithy.config.ts`, or say what to paste where the writer could not place it. */
async function editConfig(
  worker: ServiceWorker,
  edit: (source: string) => string | null,
  paste: string,
): Promise<void> {
  const path = join(worker.dir, "pithy.config.ts");
  const source = (await readOptionalFile(path)) ?? "";
  const edited = edit(source);
  if (edited === null) {
    throw new ValidationError({
      message: `Could not find the app's requiredBindings array in apps/${worker.app}/pithy.config.ts.`,
      action: paste,
    });
  }
  await writeFileAtomic(path, edited);
}

/** Write the binder's declared services into each stanza of its `wrangler.jsonc`, taking out `remove`. */
async function syncStanzas(
  options: ServiceProjectOptions,
  project: ServiceProject,
  worker: ServiceWorker,
  services: readonly ServiceDeclaration[],
  remove: readonly string[] = [],
): Promise<void> {
  const name = requireProjectName(await loadProject(options.projectDir));
  await reconcileServiceStanzas({
    workerDir: worker.dir,
    services,
    scripts: await serviceScripts(name, project.workers),
    remove,
  });
}

/**
 * Bind `from` to `to` — the logic behind `pithy worker bind`.
 *
 * Refused, in this order: a `--from` that is not an `apps/` Worker; a binding to itself; a target that is not a
 * Worker of the project, or a kit Worker nothing composes; a binding name that is not one; a second binding to a
 * target already bound under another name; a name the Worker already binds to something else; a binding that
 * would close a loop. A run that finds the binding already there changes nothing and says so.
 */
export async function bindWorker(options: BindWorkerOptions): Promise<ServiceBindReport> {
  const project = await readServiceProject(options);
  const from = resolveBinder(project, options.from);
  const target = resolveBindTarget(project, from, options.to, options.projectDir);
  const binding = options.binding ?? defaultServiceBinding(target.name);
  if (!BindingName.safeParse(binding).success) {
    throw new ValidationError({
      message: `${binding} is not a binding name.`,
      action: "Pass --binding in SCREAMING_SNAKE_CASE, like APP_B.",
    });
  }
  const bindings = requireLoaded(from);
  const report = { from: from.app, to: target.name, kind: target.kind };

  const existing = from.services.find((service) => service.target === target.name);
  if (existing) {
    if (options.binding === undefined || existing.binding === binding) {
      return { ...report, binding: existing.binding, changed: false };
    }
    throw new ConflictError({
      message: `${from.app} already binds ${target.name} as ${existing.binding}.`,
      action: `A Worker binds another once. Use ${existing.binding}, or run ${commandName("worker unbind")} first.`,
    });
  }
  const clash = bindings.find((spec) => spec.name === binding);
  if (clash) {
    throw new ConflictError({
      message: `${from.app} already binds ${binding}, to ${bindingKindPhrase(clash)}.`,
      action: "Pass a different --binding.",
    });
  }
  const loop = closesLoop(project.edges, from.app, target.name);
  if (loop) {
    throw new ConflictError({
      message: loopSentence(from.app, target.name, loop).replace(" closes ", " would close "),
      action: "Remove one binding in that path first.",
      detail: `Loop: ${renderPath(loop)}.`,
    });
  }

  const declaration = { binding, target: target.name };
  await editConfig(
    from,
    (source) => addServiceBinding(source, declaration),
    `Add ${renderServiceBinding(declaration)} to the app's requiredBindings by hand.`,
  );
  await syncStanzas(options, project, from, [...from.services, declaration]);
  return { ...report, binding, changed: true };
}

/** Options for {@link unbindWorker}. Exactly one of `to` and `binding`; the command refuses both or neither. */
export interface UnbindWorkerOptions extends ServiceProjectOptions {
  from: string;
  to?: string;
  binding?: string;
}

/**
 * Take a service binding out of `from` — the logic behind `pithy worker unbind`. The entry is chosen by the
 * Worker it calls or by its binding name; one that is not there changes nothing, and that is not a failure.
 */
export async function unbindWorker(options: UnbindWorkerOptions): Promise<ServiceBindReport> {
  const project = await readServiceProject(options);
  const from = resolveBinder(project, options.from);
  requireLoaded(from);
  const found = from.services.find((service) =>
    options.binding !== undefined ? service.binding === options.binding : service.target === options.to,
  );
  if (!found) {
    const to = options.to === undefined ? null : (appWorker(project, options.to)?.app ?? options.to);
    const kind: ServiceTargetKind | null = to === null ? null : hostWorkerFor(to) ? "kit" : "app";
    return {
      from: from.app,
      to,
      binding: options.binding ?? (to === null ? "" : defaultServiceBinding(to)),
      kind,
      changed: false,
    };
  }
  await editConfig(
    from,
    (source) => removeServiceBinding(source, { binding: found.binding }),
    `${from.app} declares ${found.binding} somewhere this cannot edit. Take it out of pithy.config.ts by hand.`,
  );
  const rest = from.services.filter((service) => service.binding !== found.binding);
  await syncStanzas(options, project, from, rest, [found.binding]);
  return {
    from: from.app,
    to: found.target,
    binding: found.binding,
    kind: hostWorkerFor(found.target) ? "kit" : "app",
    changed: true,
  };
}

/**
 * The `apps/` Workers that bind `target`, by directory name, sorted — what `pithy worker remove` refuses over.
 * A Worker binding itself is not counted: the binding goes with it.
 */
export function bindersOf(project: ServiceProject, target: string): string[] {
  const names = new Set([target, appWorker(project, target)?.app]);
  return [
    ...new Set(project.edges.filter((edge) => names.has(edge.to) && !names.has(edge.from)).map((edge) => edge.from)),
  ].sort();
}

/** The refusal `pithy worker remove` gives while another Worker binds the one it would delete. */
export function boundRefusal(target: string, binders: readonly string[]): ConflictError {
  const named = binders.length === 1 ? binders[0] : `${binders.slice(0, -1).join(", ")} and ${binders.at(-1)}`;
  return new ConflictError({
    message: `${named} ${binders.length === 1 ? "binds" : "bind"} ${target}.`,
    action: `Run ${commandName("worker unbind")} for each first.`,
    detail: binders.map((binder) => `${binder} -> ${target}`).join("; "),
  });
}

/**
 * Whether any app binds a kit Worker — so `pithy deploy` ships the kit's Workers before the adopter's, since an
 * upload binding a host that has not been deployed yet is refused. Never throws: an unreadable project binds
 * nothing it can show, and keeps the order a deploy has always had.
 */
export async function bindsKitWorker(options: ServiceProjectOptions): Promise<boolean> {
  try {
    const { edges } = await readServiceProject(options);
    return edges.some((edge) => hostWorkerFor(edge.to) !== undefined);
  } catch {
    return false;
  }
}

/**
 * The service bindings one Worker's app declares, composed for `dev` — what `pithy dev` publishes each one's
 * local address for. Never throws: a config that will not load binds nothing here, and wrangler says why.
 */
export async function declaredServices(workerDir: string): Promise<ServiceDeclaration[]> {
  try {
    return await composeFor(LOCAL_ENVIRONMENT, async (load) => appServices(await load(workerDir)));
  } catch {
    return [];
  }
}

// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import type { BindingSpec } from "@pithy-sh/core/src/capability/bindings";
import { GLOBAL_SCOPE, LOCAL_ENVIRONMENT } from "@pithy-sh/core/src/naming/environment";
import { bindingResourceName, type ProjectGlobalNaming } from "@pithy-sh/core/src/naming/provisionScope";
import { composedManifests } from "../capabilities/manifests";
import { supportBucketName } from "../capabilities/supportProvisioner";
import { loadProject, requireProjectName } from "../project/config";
import { discoverWorkers } from "../project/workers";
import { readWranglerConfig } from "../project/wrangler";

/**
 * **Whether a resource the whole project shares is actually shared — one bucket, one database, one name,
 * in every environment's stanza (#513).**
 *
 * Two bindings in the kit are project-global: `EMAIL_SUPPRESSIONS`, because "do not email this person
 * again" is not an environment-local fact, and `SUPPORT_BUCKET`, because the bytes are written from the
 * app Worker and `ensureBucket()` takes no environment. `pithy add` had no way to say so, so it wrote
 * `<project>-dev-`, `<project>-staging-` and `<project>-prod-email-suppressions` while `pithy email
 * provision` created the single `<project>-global-email-suppressions`. The app Worker and the email
 * Worker then read different suppression lists, and **an unsubscribe recorded on one was invisible to the
 * other**.
 *
 * The manifests declare it now and every writer composes one name. That fixes the projects nobody has
 * scaffolded yet. **This is the only thing that will ever tell an existing project it is split**, because
 * nothing else compares a declared name against anything: `stanzaHasBinding` keys on the binding name
 * alone — deliberately, so an adopter who repointed a binding at their own database is not told it is
 * missing — and `generatedFieldDrift` excludes a D1 `database_name` for the same reason, that a
 * `database_name` is a proposal rather than a derivation. Both are right, and neither can see this.
 *
 * So the comparison is made **here**, where it is a diagnostic rather than a writer: `doctor` reports,
 * the adopter decides, and `pithy provision --env <env>` is the command that repoints the binding.
 *
 * ## Two questions, because a split has two shapes
 *
 * 1. **The names disagree.** A stanza naming `<project>-staging-email-suppressions` where the capability
 *    creates `<project>-global-email-suppressions` is pointed at a second database — one that exists,
 *    holds its own rows, and is nobody's copy of the other.
 * 2. **The ids disagree.** Two stanzas may carry the same intent and still be bound to two different
 *    resources, because the `database_id` is what a Worker actually opens. `workflows/hostEnv.ts` states
 *    the requirement as prose — one database, "bound identically in every environment" — and this is that
 *    sentence as a check.
 *
 * ## Keyed on the capability's namer, never on the manifest's `scope`
 *
 * The expected name comes from `suppressionDatabaseName` / `supportBucketName`, reached the way every
 * optional capability is reached: a guarded dynamic import. A newer CLI beside an older
 * `@pithy-sh/email` is the ordinary skew — the packages version independently — and in that older package
 * the namer is already right while the manifest says nothing. Reading the manifest would make this check
 * go quiet on exactly the installs that need it.
 *
 * ## …and the manifest is read anyway, for the remedy rather than for the finding
 *
 * Under that same skew the finding is right and `pithy provision --env <env>` **cannot clear it**: the
 * writer composes the name from the installed manifest, and an older `@pithy-sh/email` ships one that
 * says nothing, so provisioning rewrites the per-environment name it found and `doctor` reports the split
 * again. A command that cannot work is worse than no command — it is #517's defect, and it took four
 * rounds there. So the manifest decides the *remedy* while the namer decides the *finding*: see
 * {@link SplitGlobalBinding.repointable}, which is false exactly when the package has to move first.
 */

/** One project-global binding, and the capability function that names its single resource. */
export interface GlobalBinding {
  /** The capability that owns the resource — the label a finding is reported under. */
  capability: string;
  /** The npm package an adopter upgrades when its manifest is behind the CLI. */
  package: string;
  /** The binding, as every Worker and every environment declares it. */
  binding: string;
  /** The Cloudflare namespace it lives in, which is also the `wrangler.jsonc` array it is read from. */
  kind: "d1" | "r2";
  /**
   * The capability's own name for the resource, or `null` when the package could not be loaded.
   *
   * `null` is not "no finding" — it is "this could not be checked", and {@link BindingScopeHealth.partial}
   * carries it, because a binding declared by a stanza whose package will not import is a hole rather
   * than a clean bill.
   */
  name(project: string): Promise<string | null>;
}

/**
 * The two the kit ships.
 *
 * **Hand-maintained, and gated against every shipped manifest by `cli/src/ci/globalBindings.test.ts`.** A
 * third capability declaring `scope: "global"` fails that gate until it has a row here, which is what
 * makes this list a restatement rather than a second source of truth — the disease #513 is about.
 *
 * It is a restatement rather than a derivation for the reason the docstring above gives: this check has
 * to answer under version skew, and under skew the installed manifest is the thing that is *wrong*.
 * Deriving the list from it would make the check go quiet on exactly the installs that need it — an
 * older `@pithy-sh/email` declares nothing global, so a derived list would be empty and a split project
 * would read as healthy. So the CLI carries what it knows, and the gate holds it to what ships.
 */
export const GLOBAL_BINDINGS: readonly GlobalBinding[] = [
  {
    capability: "email",
    package: "@pithy-sh/email",
    binding: "EMAIL_SUPPRESSIONS",
    kind: "d1",
    async name(project) {
      try {
        const { suppressionDatabaseName } = await import("@pithy-sh/email/src/provision/provisionEmail");
        return suppressionDatabaseName(project);
      } catch {
        return null;
      }
    },
  },
  {
    capability: "support",
    package: "@pithy-sh/support",
    binding: "SUPPORT_BUCKET",
    kind: "r2",
    // No import to guard: this namer lives in the CLI, because `pithy support provision` is a CLI command
    // and the bucket is created before `@pithy-sh/support` is reached for anything.
    async name(project) {
      return supportBucketName(project);
    },
  },
];

/** One stanza's declaration of a binding: where it is, what it calls the resource, and what it opens. */
interface BoundResource {
  /** The Worker under `apps/` whose `wrangler.jsonc` declares it. */
  worker: string;
  /** The environment stanza — `dev` for the top-level one, else the `env.<name>` key. */
  env: string;
  /** The binding name. */
  binding: string;
  /** The declared `database_name` / `bucket_name`, or `undefined` where the entry carries none. */
  name?: string;
  /** The declared `database_id` — the address a Worker actually opens. R2 has none: its name is its address. */
  id?: string;
}

/** A stanza that names something other than the project's one resource. */
export interface StaleGlobalStanza {
  /** The Worker declaring it. */
  worker: string;
  /** The environment stanza it is declared in. */
  env: string;
  /** The name it declares instead. */
  name: string;
}

/**
 * **Whether `pithy provision` can actually repoint this binding — and the package to move first when it
 * cannot.**
 *
 * The finding is keyed on the capability's namer and the remedy on the installed manifest, because those
 * are two different questions and under version skew they have two different answers. A newer CLI beside
 * an older `@pithy-sh/email` is the ordinary case — the packages version independently, and `doctor` is
 * the command run *because* something looks wrong, so it is the command most likely to meet one. There
 * the namer already composes `<project>-global-email-suppressions` while the manifest still says nothing,
 * so provisioning composes the per-environment name from the binding alone, writes it back, and leaves
 * the split exactly where it was. Printing `pithy provision --env staging` there is printing a command
 * that cannot work.
 */
interface Repointable {
  /**
   * True when the installed manifest declares what the capability's namer knows, so a provisioning run
   * writes the project's one resource into the stanza.
   *
   * False under skew, and under a capability whose manifest could not be read at all — both are "the
   * writer will compose a per-environment name", which is the fact the remedy turns on.
   */
  repointable: boolean;
  /** The package to upgrade when it is not — named because that is the whole of the extra step. */
  package: string;
}

/** One project-global binding whose stanzas do not all name the project's single resource. */
export interface SplitGlobalBinding extends Repointable {
  /** The capability that owns the resource. */
  capability: string;
  /** The binding. */
  binding: string;
  /** The Cloudflare namespace. */
  kind: "d1" | "r2";
  /** The one name the capability's own provisioner creates, and the one every stanza must carry. */
  expected: string;
  /** Every stanza naming something else, in read order. */
  stale: StaleGlobalStanza[];
}

/** One project-global binding whose stanzas are bound to more than one actual resource. */
export interface DivergentGlobalBinding extends Repointable {
  /** The capability that owns the resource. */
  capability: string;
  /** The binding. */
  binding: string;
  /**
   * The Cloudflare namespace. R2 never reaches here — a bucket's name *is* its address, so nothing fills
   * an id for one — but the field is carried rather than assumed, because what has to be carried over
   * before a repoint is different for rows than it is for objects.
   */
  kind: "d1" | "r2";
  /**
   * The one name the capability's own provisioner creates. Carried for the same reason `split` carries it:
   * the remedy names the resource the operator has to move the surviving data *into*.
   */
  expected: string;
  /** Each distinct id, and the stanzas carrying it. Always two or more entries. */
  ids: { id: string; at: { worker: string; env: string }[] }[];
}

/** What `doctor` learned about the project's project-global bindings. */
export interface BindingScopeHealth {
  ok: boolean;
  /** Bindings whose stanzas name something other than the project's resource. */
  split: SplitGlobalBinding[];
  /** Bindings whose stanzas open more than one resource. */
  divergent: DivergentGlobalBinding[];
  /**
   * True when some part of the answer could not be read — a `wrangler.jsonc` that would not parse, a
   * Worker set that would not enumerate, or a declared binding whose capability package would not import.
   *
   * It fails `ok` on #184's standard: a check that did not run is not a check that passed, and a report
   * calling a project healthy around a hole is the under-report this whole family exists to prevent.
   */
  partial: boolean;
}

/** The `wrangler.jsonc` keys this reads — the two entry kinds a project-global binding is written into. */
interface ScopedBindings {
  d1_databases?: { binding?: string; database_name?: string; database_id?: string }[];
  r2_buckets?: { binding?: string; bucket_name?: string }[];
  env?: Record<string, ScopedBindings | undefined>;
}

/** Every environment's stanza: the top-level one (the dev environment) plus each `env.<name>`. */
function envStanzas(config: ScopedBindings): { env: string; stanza: ScopedBindings }[] {
  const list: { env: string; stanza: ScopedBindings }[] = [{ env: LOCAL_ENVIRONMENT, stanza: config }];
  for (const [env, stanza] of Object.entries(config.env ?? {})) {
    if (stanza) list.push({ env, stanza });
  }
  return list;
}

/**
 * Pull one stanza's D1 and R2 entries out, whole.
 *
 * **Not `projectName.ts`'s `declaredResources`, and the difference is the point.** That reader drops any
 * entry with no `database_name` — "a binding wrangler completes later is not a claim", which is exactly
 * right for the question it answers, whether a *name* leads with the project. This one asks about
 * identity as well as name, so it keeps the `database_id` an entry carries and keeps an entry that has an
 * id and no name at all. Two questions about one file, not two answers to one question.
 */
function stanzaResources(stanza: ScopedBindings, worker: string, env: string): BoundResource[] {
  const found: BoundResource[] = [];
  for (const entry of stanza.d1_databases ?? []) {
    if (!entry.binding) continue;
    found.push({
      worker,
      env,
      binding: entry.binding,
      ...(entry.database_name ? { name: entry.database_name } : {}),
      ...(entry.database_id ? { id: entry.database_id } : {}),
    });
  }
  for (const entry of stanza.r2_buckets ?? []) {
    // An R2 bucket has no id beside its name — the name *is* the address — so nothing fills `id` here and
    // the divergence check below has nothing to say about a bucket. The name comparison covers it whole.
    if (entry.binding)
      found.push({ worker, env, binding: entry.binding, ...(entry.bucket_name ? { name: entry.bucket_name } : {}) });
  }
  return found;
}

/** What a project's own `node_modules` declares about naming one binding's resource, by binding name. */
type DeclaredNamings = ReadonlyMap<string, BindingNamingFields>;

/** The two `BindingSpec` fields a composed resource name reads — carried structurally, never re-derived. */
type BindingNamingFields = Pick<BindingSpec, "scope" | "resource">;

/** Everything read off the project's files: the stanzas, the manifests, and whether anything would not. */
interface ProjectWiring {
  /** Every project-global binding declaration across every Worker and every environment. */
  resources: BoundResource[];
  /** What the installed manifests say about naming those bindings — the remedy's input, not the finding's. */
  namings: DeclaredNamings;
  /** True when some Worker's config, or the Worker set itself, would not read. */
  unreadable: boolean;
}

/**
 * Every project-global binding declaration across every Worker and every environment, and what the
 * manifests reachable from each Worker declare about naming it.
 *
 * The two are read in one pass over the Workers because they are two halves of one answer, and because
 * `composedManifests` is per Worker: a capability declared only on the Worker composing it installs under
 * `apps/<name>/node_modules`, where a root-only scan never looks (#507). A later Worker's declaration
 * wins, which matches nothing in particular — two Workers pinning one capability to two versions is a
 * project already in trouble, and this check's job is to say the resource is split, which it still does.
 *
 * **A manifest fault is not counted `partial` here.** `doctor`'s `manifests:` section reports it above,
 * and for this check an unreadable manifest and an old one are the same fact with the same remedy: the
 * writer will compose a per-environment name, so the package has to move before provisioning can help.
 */
async function projectWiring(projectDir: string): Promise<ProjectWiring> {
  const bindings = new Set(GLOBAL_BINDINGS.map((entry) => entry.binding));
  let workers: Awaited<ReturnType<typeof discoverWorkers>>;
  try {
    workers = await discoverWorkers(projectDir);
  } catch {
    // `discoverWorkers` throws on a `pithy.worker.jsonc` that will not parse — correct for `dev` and
    // `deploy`, and exactly wrong here: `doctor` exists to work in the broken project. Same treatment
    // `declaredResources` gives it.
    return { resources: [], namings: new Map(), unreadable: true };
  }
  const resources: BoundResource[] = [];
  const namings = new Map<string, BindingNamingFields>();
  let unreadable = false;
  for (const worker of workers) {
    for (const manifest of (await composedManifests(projectDir, worker.dir)).manifests) {
      for (const spec of manifest.requiredBindings) {
        if (bindings.has(spec.name)) namings.set(spec.name, { scope: spec.scope, resource: spec.resource });
      }
    }
    // A worker with no `wrangler.jsonc` is skipped rather than counted unreadable: `apps/` also holds
    // non-Worker processes, and a Vite frontend joins the dev set through `pithy.worker.jsonc` alone.
    if (!worker.hasWrangler) continue;
    let config: ScopedBindings;
    try {
      config = (await readWranglerConfig(worker.dir)) as ScopedBindings;
    } catch {
      unreadable = true;
      continue;
    }
    for (const { env, stanza } of envStanzas(config)) {
      resources.push(...stanzaResources(stanza, worker.name, env).filter((entry) => bindings.has(entry.binding)));
    }
  }
  return { resources, namings, unreadable };
}

/**
 * What `pithy provision` would write into a stanza for this binding, or `null` where it would write a
 * **per-environment** name — which is every case that is not a `global` declaration.
 *
 * `null` rather than the per-environment string, deliberately: composing that string needs an environment
 * to put in it, and the environments here are stanza keys read out of somebody's `wrangler.jsonc`, which
 * may be anything at all. The remedy does not need the name — it needs to know the writer will not write
 * the project's one resource, and that is exactly what the absent `global` says.
 */
function provisionWouldWrite(
  project: string,
  binding: GlobalBinding,
  naming: BindingNamingFields | undefined,
): string | null {
  if (naming?.scope !== GLOBAL_SCOPE) return null;
  // The same expression `pithy add` and `pithy provision` compose with. Reading the manifest and then
  // composing the name some other way would be the third writer, in the check that exists to count them.
  return bindingResourceName(project, binding.binding, binding.kind, {
    ...naming,
    scope: GLOBAL_SCOPE,
  } satisfies ProjectGlobalNaming);
}

/**
 * The project's name for composing the expected resource names, or `null` when there is none to use.
 *
 * `requireProjectName`, never `resolveProjectName`: the fallbacks that one carries (the first Worker, then
 * the directory basename) differ between checkouts, so a comparison built on one would report every
 * correctly named resource as stale on somebody else's machine. A project with no `name` has its own
 * doctor line and is not this check's to report, so it answers nothing rather than guessing.
 */
async function projectNameFor(projectDir: string): Promise<string | null> {
  try {
    return requireProjectName(await loadProject(projectDir));
  } catch {
    return null;
  }
}

/** Whether a stale stanza is one a command can repoint. See {@link bindingScopeHealth} for why `dev` is not. */
function isFixable(stale: StaleGlobalStanza): boolean {
  return stale.env !== LOCAL_ENVIRONMENT;
}

/**
 * Compare every project-global binding this project declares against the one name its capability creates.
 *
 * **The `dev` stanza is reported and does not fail the check**, and that asymmetry is deliberate rather
 * than lenient. `pithy provision` writes `config.env[<stanza>]`, and `dev` is never a declared
 * environment, so no command reaches the top-level stanza to repoint it — a red there would be a red
 * nothing clears, on a project that is working. And it *is* working: wrangler keys a local D1 on
 * `getRemoteId(database_id) ?? binding`, and the dev entry carries no `database_id`, so locally the
 * binding name is the address and the stale `database_name` is decoration. The line says so and leaves
 * the edit to the adopter.
 */
export async function bindingScopeHealth(projectDir: string): Promise<BindingScopeHealth> {
  const project = await projectNameFor(projectDir);
  if (project === null) return { ok: true, split: [], divergent: [], partial: false };

  const { resources, namings, unreadable } = await projectWiring(projectDir);
  const split: SplitGlobalBinding[] = [];
  const divergent: DivergentGlobalBinding[] = [];
  let partial = unreadable;

  for (const global of GLOBAL_BINDINGS) {
    const declared = resources.filter((entry) => entry.binding === global.binding);
    // Nothing declares it, so there is nothing to compare — and, importantly, no reason to reach for a
    // capability package this project may well not have installed.
    if (declared.length === 0) continue;

    const expected = await global.name(project);
    if (expected === null) {
      partial = true;
      continue;
    }

    // The remedy's half. The finding above is the namer's; this asks whether the *writer* has been told
    // the same thing yet, which under version skew it has not — and there `pithy provision` would rewrite
    // the very name being reported.
    const repointable = provisionWouldWrite(project, global, namings.get(global.binding)) === expected;

    const stale = declared
      .filter((entry) => entry.name !== undefined && entry.name !== expected)
      .map((entry) => ({ worker: entry.worker, env: entry.env, name: entry.name as string }));
    if (stale.length > 0) {
      split.push({
        capability: global.capability,
        package: global.package,
        binding: global.binding,
        kind: global.kind,
        expected,
        stale,
        repointable,
      });
    }

    // Identity, beside the name. Grouped by id rather than compared pairwise so the report says which
    // stanzas share which resource — the fact an operator needs before deciding which one to keep.
    const byId = new Map<string, { worker: string; env: string }[]>();
    for (const entry of declared) {
      if (entry.id === undefined) continue;
      const at = byId.get(entry.id) ?? [];
      at.push({ worker: entry.worker, env: entry.env });
      byId.set(entry.id, at);
    }
    if (byId.size > 1) {
      divergent.push({
        capability: global.capability,
        package: global.package,
        binding: global.binding,
        kind: global.kind,
        expected,
        ids: [...byId].map(([id, at]) => ({ id, at })),
        repointable,
      });
    }
  }

  const fixable = split.some((entry) => entry.stale.some(isFixable));
  return { ok: !partial && !fixable && divergent.length === 0, split, divergent, partial };
}

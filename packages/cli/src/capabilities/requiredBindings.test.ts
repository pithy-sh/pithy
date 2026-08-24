// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { readdirSync, readFileSync, statSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { BindingSpec, BindingType } from "@pithy-sh/core/src/capability/bindings";
import { isProvisionedBinding, isWrittenBinding } from "@pithy-sh/core/src/capability/bindings";
import { CapabilityManifest } from "@pithy-sh/core/src/capability/manifest";
import { parse } from "comment-json";
import { parseAst } from "rolldown/parseAst";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import type { Node } from "../ci/workflowDrivers";
import { DEFAULT_WORKER, scaffoldProject } from "../project/scaffold";
import { addCapability, type ConfigValue } from "./add";
import { applyReconcilePlan, buildReconcilePlan } from "./reconcile";

/**
 * **A project that composes a capability has a binding for everything that capability requires.**
 *
 * That is the invariant, stated over the composition rather than over a list of capabilities, and it is
 * the one a scaffolded project broke on its very first request. `@pithy-sh/auth` declares
 * `ratelimit:AUTH_RATE_LIMITER` and `@pithy-sh/email` declares `workflow:EMAIL_SENDER`; both are
 * non-optional, `createBackend` correctly refuses to assemble without them, and **nothing wrote either
 * one**. So `pithy init` → `pithy add email` → `pithy dev` → `curl /health` answered 500, on the shortest
 * path through the product, in the order the docs teach it (#258).
 *
 * A binding is honestly one of two things, and the invariant has to admit both:
 *
 * - one `pithy add` can write into `wrangler.jsonc` offline ({@link isWrittenBinding}) — and then it is
 *   *there*, in every environment, which is what the second half of this file checks against the real
 *   writer;
 * - one whose resource only a provision command can create ({@link isProvisionedBinding}) — a Secrets
 *   Store entry, a Vectorize index — where the entry carries a value nothing offline knows, so `pithy
 *   add` says so in a note instead (`addBootstrap.ts`) rather than emitting a stanza wrangler refuses
 *   to load.
 *
 * A kind that is **neither** is the defect: nothing writes it, nothing announces it, and the adopter
 * meets it as a 500 naming a binding they have never heard of. That is exactly what `ratelimit` and
 * `workflow` were.
 *
 * Repo-wide over the shipped manifests, like `migrations/orders.test.ts` and
 * `project/capabilityVersions.test.ts`, and for the same reason: the property is only true as a set. A
 * capability added next year gets this gate for free.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const PACKAGES = join(HERE, "../../../../packages");

/** Whether a path exists — `statSync` throwing is the only way to ask without a race. */
function exists(path: string): boolean {
  try {
    statSync(path);
    return true;
  } catch {
    return false;
  }
}

/** Every shipped capability manifest, by package directory. */
function shippedManifests(): { pkg: string; manifest: CapabilityManifest }[] {
  const found: { pkg: string; manifest: CapabilityManifest }[] = [];
  for (const dir of readdirSync(PACKAGES).sort()) {
    const path = join(PACKAGES, dir, "pithy.manifest.json");
    if (!exists(path)) continue;
    found.push({ pkg: dir, manifest: CapabilityManifest.parse(JSON.parse(readFileSync(path, "utf8"))) });
  }
  return found;
}

const MANIFESTS = shippedManifests();

/**
 * Every package that ships a `pithy.manifest.json`. **A frozen literal**, and the population every
 * sweep in this file quantifies over.
 *
 * Without it the whole file is one `readdirSync` away from vacuous: an empty walk makes every `for`
 * below iterate nothing, every `expect(x).toEqual([])` pass, and `test.each` register no tests at all —
 * a green file asserting nothing, which is the shape this repository has shipped eight times. Exact
 * rather than a floor, because the point is that a sixteenth capability *joins* these sweeps: a new
 * manifest fails here once, and the fix is to add its name.
 */
const SHIPPED_MANIFESTS = [
  "audit",
  "auth",
  "core",
  "email",
  "i18n",
  "leaderboard",
  "ledger",
  "matchmaking",
  "media",
  "multiplayer",
  "payments",
  "rating",
  "secrets",
  "storage",
  "support",
  "testers",
  "turnstile",
  "vector",
];

/**
 * A binding as every check here reads one: its kind and its name.
 *
 * Structural rather than `BindingSpec`, because the same two questions are asked of a manifest's
 * declaration and of what an apply reported writing, and those are different types carrying the same
 * pair. Narrowing to one of them is how a check ends up covering half the surface it reads about.
 */
type BindingRef = { type: BindingType; name: string };

/** How a binding is named in a failure, matching `validateBindings`: `workflow:EMAIL_SENDER`. */
function label(binding: BindingRef): string {
  return `${binding.type}:${binding.name}`;
}

/** The bindings a capability's own composition refuses to boot without — the ones this gate is about. */
function required(manifest: CapabilityManifest): BindingSpec[] {
  return manifest.requiredBindings.filter((binding) => !binding.optional);
}

/**
 * Every workflow binding a manifest declares that the writer could not emit a complete entry for,
 * labeled `<pkg>: workflow:<NAME>`.
 *
 * **The invariant, not a list of the packages that broke it.** A `workflows` entry needs `name` and
 * `class_name`, both derived from the binding's `job` and `className`, so a binding missing either is
 * one `project/bindingEntries.ts` declines to write — silently, since there is nothing honest to emit.
 * Whether the app may boot without the binding is a different question with a different field, and
 * conflating them is what kept this green through #318.
 */
function incompleteWorkflowBindings(manifests: readonly { pkg: string; manifest: CapabilityManifest }[]): string[] {
  const incomplete: string[] = [];
  for (const { pkg, manifest } of manifests) {
    for (const binding of manifest.requiredBindings) {
      if (binding.type !== "workflow") continue;
      if (binding.job === undefined || binding.className === undefined) incomplete.push(`${pkg}: ${label(binding)}`);
    }
  }
  return incomplete;
}

/**
 * Every Durable Object class a **set of bindings** names, sorted and deduplicated.
 *
 * **Over the bindings, never over the manifest**, and that is the whole of the answer to `optional`. The
 * rule is one sentence — *the entry exports exactly the classes this Worker binds* — and the two writers
 * bind different sets from the same manifest: `pithy add` runs before any config exists and writes the
 * non-optional bindings, while `pithy upgrade` writes what the Worker's composed set actually derives
 * ({@link effectiveBindings}). Both are right, so this takes the list rather than deciding for them.
 *
 * The earlier shape decided, and decided against both of them: it read every binding a manifest declared,
 * optional included, on the reasoning that "a class the writer put in `durable_objects.bindings` has to be
 * there whatever the flag says". True — but the writer puts an optional one in no stanza at all, so the
 * gate demanded an export for a class no `class_name` resolves against. Nothing shipped an optional
 * Durable Object binding, so nothing failed; the first one would have turned this red for a project that
 * was correct.
 */
function durableObjectClasses(bindings: readonly BindingSpec[]): string[] {
  return [
    ...new Set(
      bindings
        .filter((binding) => binding.type === "durable_object" && binding.className !== undefined)
        .map((binding) => binding.className as string),
    ),
  ].sort();
}

/** Every `class_name` one environment's stanza binds a Durable Object namespace to. */
function wiredDurableObjectClasses(stanza: Record<string, unknown>): string[] {
  const bindings = (stanza.durable_objects as { bindings?: Record<string, unknown>[] } | undefined)?.bindings ?? [];
  return bindings.map((entry) => String(entry.class_name));
}

/**
 * Every value-kind name a module exports, read from its syntax tree.
 *
 * **The judge is deliberately not the writer.** `capabilities/entryExports.ts` has a reader of its own —
 * a scanner, because it ships and the parser here is a dev-only dependency — and a gate that asked the
 * writer whether the writer had written something would be green on any reader that answered its own
 * question. This one parses, with rolldown's oxc, exactly as `ci/workflowDrivers.ts` does.
 *
 * `exportKind` is what decides, not the word: `verbatimModuleSyntax` erases a type-only export, so
 * `export type { MultiplayerSession }` puts no class on the emitted module and wrangler's `class_name`
 * still resolves to nothing — the same fact `hasDefaultExport` turns on for #426.
 */
function exportedNames(text: string): string[] {
  const program = parseAst(text, { lang: "ts" }, "entry.ts") as unknown as Node;
  const body = Array.isArray(program.body) ? (program.body as Node[]) : [];
  const names: string[] = [];
  for (const statement of body) {
    if (statement.type !== "ExportNamedDeclaration" || statement.exportKind === "type") continue;
    const specifiers = Array.isArray(statement.specifiers) ? (statement.specifiers as Node[]) : [];
    for (const specifier of specifiers) {
      if (specifier.exportKind === "type") continue;
      const exported = specifier.exported as { name?: unknown } | undefined;
      if (typeof exported?.name === "string") names.push(exported.name);
    }
    // `export class MultiplayerSession {}` — an adopter's own class, exported where it is declared.
    const declaration = statement.declaration as { id?: { name?: unknown } } | undefined;
    if (typeof declaration?.id?.name === "string") names.push(declaration.id.name);
  }
  return names;
}

describe("every required binding has somewhere to come from", () => {
  test("the sweeps below are quantified over the real manifests", () => {
    // The anti-vacuity guard the whole file was missing. Every assertion here is `for (… of MANIFESTS)`
    // or `test.each(MANIFESTS)`, and both are green over nothing — so a `readdirSync` that returned an
    // empty list, a `PACKAGES` path that moved, or a `CapabilityManifest.parse` that silently dropped
    // every entry would leave this file passing while checking no capability at all.
    expect(MANIFESTS.map(({ pkg }) => pkg)).toEqual(SHIPPED_MANIFESTS);
    // And every one really parsed into something with the field the sweeps read.
    for (const { pkg, manifest } of MANIFESTS) {
      expect(Array.isArray(manifest.requiredBindings), `${pkg} has no requiredBindings array`).toBe(true);
    }
    // The sweeps would also be vacuous over fifteen manifests that declare nothing. At least one real
    // binding of each kind the two halves of this file are about has to be in the set.
    const kinds = new Set(MANIFESTS.flatMap(({ manifest }) => manifest.requiredBindings.map((b) => b.type)));
    expect(kinds).toContain("d1");
    expect(kinds).toContain("workflow");
    expect(kinds).toContain("durable_object");
    // And the Durable Object sweep below is quantified over real classes, not over an empty `className`
    // on every one of them — three, across `multiplayer` and `matchmaking`.
    expect(MANIFESTS.flatMap(({ manifest }) => durableObjectClasses(manifest.requiredBindings)).sort()).toEqual([
      "MatchmakingPresence",
      "MatchmakingQueue",
      "MultiplayerSession",
    ]);
  });

  test("each is either written by pithy add or created by a provision command", () => {
    const orphaned: string[] = [];
    for (const { pkg, manifest } of MANIFESTS) {
      for (const binding of required(manifest)) {
        if (isWrittenBinding(binding.type) || isProvisionedBinding(binding.type)) continue;
        orphaned.push(`${pkg}: ${label(binding)}`);
      }
    }
    expect(orphaned).toEqual([]);
  });

  test("it bites — a planted binding of a kind nothing writes is orphaned", () => {
    // The planted violation. `queue` is a real `BindingType` that no shipped capability declares and no
    // writer emits, so a capability that declared one would boot into "Missing required bindings:
    // queue:PLANTED" with no command anywhere to fix it. This is the shape `ratelimit` and `workflow`
    // had before #258.
    const planted = CapabilityManifest.parse({
      name: "planted",
      package: "@pithy-sh/planted",
      requiredBindings: [{ type: "queue", name: "PLANTED" }],
    });
    const orphaned = required(planted).filter(
      (binding) => !isWrittenBinding(binding.type) && !isProvisionedBinding(binding.type),
    );
    expect(orphaned.map(label)).toEqual(["queue:PLANTED"]);
  });

  test("every Durable Object class really is exported by the module its binding names", () => {
    // The claim `classModule` makes is about another package's files, so it is checked against them —
    // `catalog.test.ts`'s rule for the import specifier `pithy add` writes, one export keyword over. A
    // specifier that resolves to nothing, or to a module that does not export the class, is a Worker
    // that fails at bundle time on a line the CLI wrote.
    const wrong: string[] = [];
    for (const { pkg, manifest } of MANIFESTS) {
      for (const binding of manifest.requiredBindings) {
        if (binding.type !== "durable_object") continue;
        const { className, classModule } = binding;
        if (className === undefined || classModule === undefined) continue;
        // Inside the capability's own package, and never its entry point: `src/index` is what an
        // adopter's `pithy.config.ts` imports in Node, and a Durable Object on that path imports
        // `cloudflare:workers` and takes every Node-side command down with it (#172, #180).
        const inside = classModule.startsWith(`${manifest.package}/`);
        const path = join(PACKAGES, pkg, `${classModule.slice(manifest.package.length + 1)}.ts`);
        if (!inside || classModule === `${manifest.package}/src/index` || !exists(path)) {
          wrong.push(`${pkg}: ${classModule} is not a module of ${manifest.package}`);
          continue;
        }
        if (!new RegExp(`export class ${className}\\b`).test(readFileSync(path, "utf8"))) {
          wrong.push(`${pkg}: ${classModule} exports no ${className}`);
        }
      }
    }
    expect(wrong).toEqual([]);
  });

  test("a workflow binding nothing can name is refused, because a partial entry fails wrangler's validator", () => {
    // A `workflows` entry needs a `name` and a `class_name`, and both are derived from the job and the
    // exported class. A manifest that declares neither leaves the writer with nothing to emit — so the
    // binding would be "written" in name only and the Worker would still refuse its first request.
    //
    // **Over every workflow binding, optional included** — the filter that made this gate green while
    // five capabilities shipped unwritable bindings (#318). `optional` answers "may the app boot
    // without it", which is `createBackend`'s question. It says nothing about whether the entry is
    // derivable offline, which is this one's, and {@link isWrittenBinding} already answers that with
    // `true` for every workflow. So a gate that skipped the optional ones was checking the writer
    // against exactly the bindings the writer never had trouble with.
    expect(incompleteWorkflowBindings(MANIFESTS)).toEqual([]);
  });

  test("it bites — a planted optional workflow binding with no job is caught", () => {
    // The planted violation, and it is planted *optional* on purpose: that is the shape all five of
    // #318's bindings had. PAYMENTS_RECONCILE, STORAGE_SWEEP, SUPPORT_CLASSIFY, TESTERS_DAILY and
    // VECTOR_REPROCESS each declared `optional: true` and neither `job` nor `className`, `pithy
    // upgrade` reported writing them, `bindingEntries.workflowEntry` returned undefined for every one,
    // and this file was green throughout.
    const planted = CapabilityManifest.parse({
      name: "planted",
      package: "@pithy-sh/planted",
      requiredBindings: [{ type: "workflow", name: "PLANTED_SWEEP", optional: true }],
    });
    expect(incompleteWorkflowBindings([{ pkg: "planted", manifest: planted }])).toEqual([
      "planted: workflow:PLANTED_SWEEP",
    ]);
  });
});

/**
 * The other half: the kinds that claim to be written really are, through the real writer, into a real
 * scaffold. A predicate that says "add writes this" and an `add` that does not is the same defect wearing
 * a different hat.
 */
describe("what pithy add claims to write, it writes", () => {
  let dir: string;
  let worker: string;

  /** Install a manifest where every Worker's manifests resolve from — the project root's node_modules. */
  async function writeManifest(projectDir: string, manifest: CapabilityManifest): Promise<void> {
    const pkgDir = join(projectDir, "node_modules", "@pithy-sh", manifest.name);
    await mkdir(pkgDir, { recursive: true });
    await writeFile(join(pkgDir, "pithy.manifest.json"), JSON.stringify(manifest));
  }

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "pithy-bindings-"));
    await scaffoldProject({ targetDir: dir, appName: "bindings" });
    worker = join(dir, "apps", DEFAULT_WORKER);
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  /** Whether one environment's stanza declares a binding, by the key wrangler files each kind under. */
  function declares(stanza: Record<string, unknown>, binding: BindingRef): boolean {
    const list = (key: string): Record<string, unknown>[] =>
      Array.isArray(stanza[key]) ? (stanza[key] as Record<string, unknown>[]) : [];
    switch (binding.type) {
      case "d1":
        return list("d1_databases").some((entry) => entry.binding === binding.name);
      case "kv":
        return list("kv_namespaces").some((entry) => entry.binding === binding.name);
      case "r2":
        return list("r2_buckets").some((entry) => entry.binding === binding.name);
      case "ai":
        return (stanza.ai as { binding?: string } | undefined)?.binding === binding.name;
      case "durable_object":
        return ((stanza.durable_objects as { bindings?: Record<string, unknown>[] } | undefined)?.bindings ?? []).some(
          (entry) => entry.name === binding.name,
        );
      case "ratelimit":
        return list("ratelimits").some((entry) => entry.name === binding.name);
      case "workflow":
        return list("workflows").some((entry) => entry.binding === binding.name);
      default:
        return false;
    }
  }

  /**
   * An answer for every option the manifest states no default for — the first of its choices.
   *
   * A required option has no value the writer may invent, so `addCapability` refuses rather than render
   * one (#412). This suite is about *bindings*; it settles the question the way an adopter would so the
   * wiring it is really asserting still runs.
   */
  function answers(manifest: CapabilityManifest): Record<string, ConfigValue> {
    const values: Record<string, ConfigValue> = {};
    for (const option of manifest.configOptions) {
      if (option.default === undefined && option.choices?.[0] !== undefined) values[option.key] = option.choices[0];
    }
    return values;
  }

  test.each(MANIFESTS.map(({ pkg, manifest }) => [pkg, manifest] as const))(
    "%s: every written binding lands in every environment",
    async (_pkg, manifest) => {
      await addCapability({ workerDir: worker, manifest, configValues: answers(manifest), project: "bindings" });
      const config = parse(await readFile(join(worker, "wrangler.jsonc"), "utf8")) as unknown as Record<
        string,
        unknown
      > & { env?: Record<string, Record<string, unknown>> };

      const stanzas: [string, Record<string, unknown>][] = [["dev", config]];
      for (const [env, stanza] of Object.entries(config.env ?? {})) stanzas.push([env, stanza]);

      const missing: string[] = [];
      for (const binding of required(manifest)) {
        if (!isWrittenBinding(binding.type)) continue;
        for (const [env, stanza] of stanzas) {
          if (!declares(stanza, binding)) missing.push(`${env}: ${label(binding)}`);
        }
      }
      expect(missing).toEqual([]);
    },
  );

  /**
   * **Every Durable Object class the wiring names is exported by the entry the scaffolder writes.** (#428)
   *
   * A `durable_objects.bindings` entry is one half of a Durable Object. The other half is a named export
   * on the module `main` points at, and wrangler refuses the deploy without it:
   *
   *     Your Worker depends on the following Durable Objects, which are not exported in your entrypoint
   *     file: MultiplayerSession.
   *
   * `pithy add` wrote both halves of the config — the binding and the `new_sqlite_classes` tag — and left
   * the export to a human, whose only prompt was a line in the manifest's `scaffold` prose. So `pithy add
   * multiplayer` produced a project that could not deploy, and `pithy add matchmaking` one that could not
   * deploy for two more classes.
   *
   * **Derived on both sides, so a fourth class is covered by the fact of being declared.** The classes come
   * from what the real writer put in the real file, checked against what the manifests declare so nothing
   * can go missing between the two views; the exports come from parsing the entry the real scaffolder
   * wrote. Nothing here names a class, and the sweep is `test.each(MANIFESTS)` — a capability that ships a
   * Durable Object tomorrow joins it with nothing to remember.
   *
   * It rides on this describe's fixture on purpose, and that fixture's project (`bindings`) and Worker
   * (`api`) differ: a fixture where both were the same is what hid #136 for months.
   *
   * **Here rather than in `ci/workflowDrivers.ts`**, which is #426's gate and the shape this follows. That
   * one extends the walk it needs: both sides of its rule — the `WorkflowEntrypoint` subclasses and the
   * modules holding them — are files in this repository. Only one side of this rule is. The other is a
   * file that does not exist until the scaffolder writes it, and this sweep is the walk that already runs
   * the real scaffolder over the real manifests. Adding a second scan of `packages/` would not have seen
   * it.
   */
  test.each(MANIFESTS.map(({ pkg, manifest }) => [pkg, manifest] as const))(
    "%s: every Durable Object class it binds is exported by the Worker entry",
    async (pkg, manifest) => {
      await addCapability({ workerDir: worker, manifest, configValues: answers(manifest), project: "bindings" });
      const config = parse(await readFile(join(worker, "wrangler.jsonc"), "utf8")) as unknown as Record<
        string,
        unknown
      > & { env?: Record<string, Record<string, unknown>> };

      const stanzas: Record<string, unknown>[] = [config, ...Object.values(config.env ?? {})];
      const wired = [...new Set(stanzas.flatMap(wiredDurableObjectClasses))].sort();
      // The two views agree: every class `pithy add` is meant to wire got a binding, and no binding names
      // a class no manifest asked for. A class dropped here would make the export check below quietly
      // narrower than the rule it states. `required` rather than every declared binding, because that is
      // the set this writer wires — see {@link durableObjectClasses}.
      expect(wired).toEqual(durableObjectClasses(required(manifest)));

      // The entry is whatever `main` names, resolved against the Worker — the same module wrangler
      // resolves `class_name` against, never an assumption about where a Worker keeps its entry.
      const entry = await readFile(join(worker, String(config.main)), "utf8");
      const exported = new Set(exportedNames(entry));
      expect(wired.filter((className) => !exported.has(className)).map((className) => `${pkg}: ${className}`)).toEqual(
        [],
      );
    },
  );

  test("it bites — an optional Durable Object binding is wired nowhere, so it is demanded nowhere", async () => {
    // The answer to the one question the two halves of this gate used to disagree about (#428 review).
    // `optional` means the capability needs the binding only under a particular config, and `pithy add`
    // runs before any config exists — so it writes no stanza for one. Everything downstream follows that
    // single decision: no `durable_objects.bindings` entry, no `new_sqlite_classes` tag, no export.
    //
    // Nothing shipped declares an optional Durable Object binding, which is exactly why this is planted:
    // the rule is true today by accident and has to be true by construction.
    const planted = CapabilityManifest.parse({
      name: "planted",
      package: "@pithy-sh/planted",
      requiredBindings: [
        {
          type: "durable_object",
          name: "PLANTED_ROOM",
          className: "PlantedRoom",
          classModule: "@pithy-sh/planted/src/room/durableObject",
        },
        {
          type: "durable_object",
          name: "PLANTED_GHOST",
          className: "PlantedGhost",
          classModule: "@pithy-sh/planted/src/ghost/durableObject",
          optional: true,
        },
      ],
    });
    await addCapability({ workerDir: worker, manifest: planted, configValues: {}, project: "bindings" });
    const config = parse(await readFile(join(worker, "wrangler.jsonc"), "utf8")) as unknown as Record<
      string,
      unknown
    > & { env?: Record<string, Record<string, unknown>>; migrations?: { new_sqlite_classes?: string[] }[] };

    const stanzas: Record<string, unknown>[] = [config, ...Object.values(config.env ?? {})];
    expect([...new Set(stanzas.flatMap(wiredDurableObjectClasses))].sort()).toEqual(["PlantedRoom"]);
    // The gate asks for the writer's set, not the manifest's — the half that was stating the opposite rule.
    expect(durableObjectClasses(required(planted))).toEqual(["PlantedRoom"]);

    // The class migration tag follows the binding too. A `new_sqlite_classes` naming a class the Worker
    // neither binds nor exports registers an actor nothing can reach, against a script that does not carry
    // it — and a tag is applied once and never revisited, so it is not a mistake a later run repairs.
    expect((config.migrations ?? []).flatMap((migration) => migration.new_sqlite_classes ?? [])).toEqual([
      "PlantedRoom",
    ]);

    const exported = exportedNames(await readFile(join(worker, String(config.main)), "utf8"));
    expect(exported).toContain("PlantedRoom");
    expect(exported).not.toContain("PlantedGhost");
  });

  /**
   * **What `pithy upgrade` reports adding is in the file.**
   *
   * The invariant #318 was reported about, stated over the report rather than over any binding. `upgrade`
   * said "payments: added 3 bindings", `git diff` showed none, and `pithy doctor` — the tool this kit
   * tells adopters to trust over memory — still called `PAYMENTS_RECONCILE` missing seconds later. Two
   * commands of one CLI disagreeing about a file one of them had just written.
   *
   * Optional bindings included, because every one of the five was optional. `upgrade` differs from `add`
   * here: `add` skips an optional binding outright, while `upgrade` writes the ones the Worker's composed
   * set actually derives — which is how these came to be reported at all.
   */
  test.each(MANIFESTS.map(({ pkg, manifest }) => [pkg, manifest] as const))(
    "%s: every binding pithy upgrade reports adding is in the file afterwards",
    async (_pkg, manifest) => {
      await writeManifest(dir, manifest);
      // The composed set as `createBackend` derives it — the manifest's own bindings, optional ones
      // included. That is what makes an optional binding effective for a plan, and it is the state the
      // dashboard was in when it hit this.
      const composed = [{ name: manifest.name, requiredBindings: manifest.requiredBindings }];
      const plan = await buildReconcilePlan({
        account: null,
        projectDir: dir,
        workerDir: worker,
        env: "dev",
        capabilities: composed,
      });
      const applied = await applyReconcilePlan({
        account: null,
        projectDir: dir,
        workerDir: worker,
        plan,
        migrate: false,
        env: "dev",
        capabilities: composed,
        // The project name every derived resource name starts with. Without it the writer honestly
        // declines a Workflow entry, and a sweep run that way would be green over an empty set — the
        // exact shape of gate this issue is about.
        project: "bindings",
      });

      const config = parse(await readFile(join(worker, "wrangler.jsonc"), "utf8")) as unknown as Record<
        string,
        unknown
      > & { env?: Record<string, Record<string, unknown>> };
      const byEnv = new Map<string, Record<string, unknown>>([["dev", config]]);
      for (const [env, stanza] of Object.entries(config.env ?? {})) byEnv.set(env, stanza);

      const claimed: string[] = [];
      for (const cap of applied.perCapability) {
        // A skip is honest and is allowed — it is named, with a reason. What is not allowed is a binding
        // in `addedBindings` that the file does not have.
        for (const added of cap.addedBindings) {
          const stanza = byEnv.get(added.env);
          if (!stanza || !declares(stanza, added)) claimed.push(`${added.env}: ${label(added)}`);
        }
      }
      expect(claimed).toEqual([]);

      // And the other half of #318's report: `pithy doctor`, run immediately after, against the same
      // tree. Doctor renders exactly this plan (`doctor/health.ts` → `groupMissingBindings`), so a
      // capability still naming a missing binding here is the two commands disagreeing about a file one
      // of them has just written — which is what an adopter actually met.
      const after = await buildReconcilePlan({
        account: null,
        projectDir: dir,
        workerDir: worker,
        env: "dev",
        capabilities: composed,
      });
      const stillMissing = after.perCapability.flatMap((cap) =>
        cap.missingBindings.map((binding) => `${binding.env}: ${label(binding)}`),
      );
      expect(stillMissing).toEqual([]);
    },
  );

  /**
   * **The same rule, against the other writer.** (#428)
   *
   * `pithy add` was not the only thing writing a `durable_objects.bindings` entry with a `class_name` in
   * it — `pithy upgrade`'s reconcile writes one into every environment of a Worker that is missing it, and
   * for a while it was the one path that still left the export to a human. So the defect this issue is
   * about survived its own fix on the command an adopter reaches for *because* something is wrong.
   *
   * A property held by one of two writers is not held. The sweep is the add-side one, quantified the same
   * way and derived on both sides, pointed at `applyReconcilePlan` instead — and it stays honest about the
   * difference between them: `upgrade` writes the bindings the Worker's composed set derives, optional ones
   * included, so the classes it must export are the composed set's rather than `add`'s narrower list.
   *
   * The report is checked against the file for the same reason #318's is. `upgrade` writing an adopter's
   * entry and saying nothing is the shape that issue was reported about, one file over.
   */
  test.each(MANIFESTS.map(({ pkg, manifest }) => [pkg, manifest] as const))(
    "%s: every Durable Object class pithy upgrade wires is exported by the Worker entry",
    async (pkg, manifest) => {
      await writeManifest(dir, manifest);
      const composed = [{ name: manifest.name, requiredBindings: manifest.requiredBindings }];
      const applied = await applyReconcilePlan({
        account: null,
        projectDir: dir,
        workerDir: worker,
        plan: await buildReconcilePlan({
          account: null,
          projectDir: dir,
          workerDir: worker,
          env: "dev",
          capabilities: composed,
        }),
        migrate: false,
        env: "dev",
        capabilities: composed,
        project: "bindings",
      });

      const config = parse(await readFile(join(worker, "wrangler.jsonc"), "utf8")) as unknown as Record<
        string,
        unknown
      > & { env?: Record<string, Record<string, unknown>> };
      const stanzas: Record<string, unknown>[] = [config, ...Object.values(config.env ?? {})];
      const wired = [...new Set(stanzas.flatMap(wiredDurableObjectClasses))].sort();
      // Every class the composed set declares got a binding here, and no binding names a class nothing
      // asked for — so the export check below is over the whole rule and not a corner of it.
      expect(wired).toEqual(durableObjectClasses(manifest.requiredBindings));

      const exported = new Set(exportedNames(await readFile(join(worker, String(config.main)), "utf8")));
      expect(wired.filter((className) => !exported.has(className)).map((className) => `${pkg}: ${className}`)).toEqual(
        [],
      );
      // And `upgrade` says what it wrote into the adopter's entry, exactly as it says what it wrote into
      // their wrangler.jsonc.
      expect([...applied.addedEntryExports].sort()).toEqual(wired);
    },
  );

  test("a project wired before the export existed is repaired, though its plan reports no drift", async () => {
    // The case that decides *how much* the reconcile writer looks at, and the one an adopter is actually
    // in. A project scaffolded by the pre-#428 CLI has the `durable_objects.bindings` entry and the class
    // migration tag already, so nothing is missing and the plan is empty — and that project is precisely
    // who runs `pithy upgrade`, because `wrangler deploy` has just refused it. A writer keyed on missing
    // bindings would read the empty plan and leave the Worker exactly as undeployable as it found it.
    const multiplayer = MANIFESTS.find((entry) => entry.pkg === "multiplayer")?.manifest as CapabilityManifest;
    await writeManifest(dir, multiplayer);
    await addCapability({
      workerDir: worker,
      manifest: multiplayer,
      configValues: answers(multiplayer),
      project: "bindings",
    });

    const config = parse(await readFile(join(worker, "wrangler.jsonc"), "utf8")) as unknown as { main: string };
    const entryPath = join(worker, config.main);
    // Roll the entry back to what that CLI left behind: everything but the export.
    const before = (await readFile(entryPath, "utf8"))
      .split("\n")
      .filter((line) => !line.startsWith("export { ") && !line.startsWith("// Durable Object classes"))
      .join("\n");
    await writeFile(entryPath, before);
    expect(exportedNames(before)).not.toContain("MultiplayerSession");

    const composed = [{ name: multiplayer.name, requiredBindings: multiplayer.requiredBindings }];
    const plan = await buildReconcilePlan({
      account: null,
      projectDir: dir,
      workerDir: worker,
      env: "dev",
      capabilities: composed,
    });
    expect(plan.perCapability.flatMap((cap) => cap.missingBindings)).toEqual([]);

    const applied = await applyReconcilePlan({
      account: null,
      projectDir: dir,
      workerDir: worker,
      plan,
      migrate: false,
      env: "dev",
      capabilities: composed,
      project: "bindings",
    });
    expect(applied.addedEntryExports).toEqual(["MultiplayerSession"]);
    expect(exportedNames(await readFile(entryPath, "utf8"))).toContain("MultiplayerSession");
  });

  test("it bites — a binding the writer declines is named as skipped, never counted as added", async () => {
    // The planted violation, in #318's exact shape: an optional workflow binding stating no `job` and no
    // `className`, which `project/bindingEntries.ts` cannot compose a `workflows` entry from. Before the
    // fix, `applyBindings` copied the plan into `addedBindings` the moment it touched the capability, so
    // this is the assertion that was impossible to make.
    const planted = CapabilityManifest.parse({
      name: "planted",
      package: "@pithy-sh/planted",
      requiredBindings: [{ type: "workflow", name: "PLANTED_SWEEP", optional: true }],
    });
    await writeManifest(dir, planted);
    const composed = [{ name: planted.name, requiredBindings: planted.requiredBindings }];
    const before = await readFile(join(worker, "wrangler.jsonc"), "utf8");

    const applied = await applyReconcilePlan({
      account: null,
      projectDir: dir,
      workerDir: worker,
      plan: await buildReconcilePlan({
        account: null,
        projectDir: dir,
        workerDir: worker,
        env: "dev",
        capabilities: composed,
      }),
      migrate: false,
      env: "dev",
      capabilities: composed,
      project: "bindings",
    });

    const cap = applied.perCapability.find((entry) => entry.name === "planted");
    expect(cap?.addedBindings).toEqual([]);
    expect(cap?.skippedBindings.map((skipped) => `${skipped.env}: ${skipped.name} — ${skipped.reason}`)).toEqual([
      "dev: PLANTED_SWEEP — PLANTED_SWEEP declares no job",
      "staging: PLANTED_SWEEP — PLANTED_SWEEP declares no job",
      "prod: PLANTED_SWEEP — PLANTED_SWEEP declares no job",
    ]);
    // And nothing was written, so the file the adopter would `git diff` is untouched.
    expect(await readFile(join(worker, "wrangler.jsonc"), "utf8")).toBe(before);
  });
});

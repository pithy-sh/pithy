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
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { DEFAULT_WORKER, scaffoldProject } from "../project/scaffold";
import { addCapability } from "./add";
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
 * labelled `<pkg>: workflow:<NAME>`.
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

describe("every required binding has somewhere to come from", () => {
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

  test.each(MANIFESTS.map(({ pkg, manifest }) => [pkg, manifest] as const))(
    "%s: every written binding lands in every environment",
    async (_pkg, manifest) => {
      await addCapability({ workerDir: worker, manifest, project: "bindings" });
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

// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { BindingSpecInput } from "@pithy-sh/core/src/capability/bindings";
import { type Capability, defineCapability } from "@pithy-sh/core/src/capability/capability";
import { environmentScope } from "@pithy-sh/core/src/naming/provisionScope";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { type ProvisionWorker, provisionEnvironment } from "./environment";
import { formatProvisionPlan, provisionPlan } from "./plan";
import type { ResourceProvisioner, ResourceProvisioners } from "./resources";

/**
 * **The plan says what the run will do, and it is the run's own input rather than a second guess (#515).**
 *
 * A plan an operator reads before typing a production confirmation phrase is only worth printing if it
 * cannot drift from the work. The failure it replaces is not silence — it is a plan that lists a bucket
 * every declining Worker had removed, read by someone who then goes looking for it.
 */

/** An in-memory provisioner over a name→id map, mirroring the real find/create semantics. */
function fakeKind(kind: string, store: Map<string, string>): ResourceProvisioner {
  let seq = 0;
  return {
    find: async (name: string) => (store.has(name) ? { id: store.get(name) as string } : null),
    create: async (name: string) => {
      seq += 1;
      const id = `${kind}-${seq}`;
      store.set(name, id);
      return { id };
    },
    delete: async (id: string) => {
      for (const [name, value] of store) if (value === id) store.delete(name);
    },
  };
}

function fakeProvisioners(): ResourceProvisioners {
  return {
    d1: fakeKind("d1", new Map()),
    kv: fakeKind("kv", new Map()),
    r2: fakeKind("r2", new Map()),
  } as unknown as ResourceProvisioners;
}

/** The Worker's app capability: one of each provisionable kind, with the bucket declinable. */
const app = defineCapability({
  name: "app",
  requiredBindings: [
    { type: "d1", name: "DB" },
    { type: "kv", name: "CACHE" },
    { type: "r2", name: "ASSETS", optional: true },
  ] satisfies BindingSpecInput[],
});

/**
 * A secrets capability, hand-built rather than composed. `isSecretsCapability` asks only for the name and
 * the registry, and the real one brings its own bindings — which would put resources in the plan that this
 * suite is not about.
 */
const secrets = {
  name: "secrets",
  requiredBindings: [],
  secretRegistry: {
    SESSION_SIGNING_KEY: { backend: "cf-secrets-store", scope: "environment", rotatable: true, valueType: "text" },
    // `global` resolves to one account-level entry, whatever the environment — so it is named as such.
    RELEASE_INGEST_SECRET: { backend: "cf-secrets-store", scope: "global", rotatable: false, valueType: "text" },
    // A `d1` secret lives in the environment's own database and is bound by nothing here.
    WEBHOOK_SIGNING_KEY: { backend: "d1", scope: "environment", rotatable: true, valueType: "text" },
  },
} as unknown as Capability;

describe("the plan pithy provision prints before it provisions", () => {
  let dir: string;
  let workerDir: string;
  const scope = environmentScope("replay", "staging");
  const noBackend = { seedData: false, migrate: async () => {}, seed: async () => {} };

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "pithy-plan-"));
    workerDir = join(dir, "apps", "board");
    await mkdir(workerDir, { recursive: true });
    await writeFile(join(workerDir, "wrangler.jsonc"), '{\n  "name": "replay-board"\n}\n');
    // A decline resolves against what the Worker composes, and that needs the manifest on disk — without
    // it the name is `unrecognized`, which changes nothing and would make the fixture prove nothing.
    const pkgDir = join(dir, "node_modules", "@pithy-sh", "app");
    await mkdir(pkgDir, { recursive: true });
    await writeFile(
      join(pkgDir, "pithy.manifest.json"),
      JSON.stringify({
        name: "app",
        package: "@pithy-sh/app",
        requiredBindings: [
          { type: "d1", name: "DB" },
          { type: "kv", name: "CACHE" },
          { type: "r2", name: "ASSETS", optional: true },
        ],
      }),
    );
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  /** The Worker set both halves share: one Worker, declining the bucket its capability made optional. */
  const workers = (): ProvisionWorker[] => [
    {
      name: "replay-board",
      dir: workerDir,
      capabilities: [app, secrets],
      config: { capabilities: [], declinedBindings: { ASSETS: "no R2 in this account" } } as never,
    },
  ];

  const capabilities = [app, secrets];

  /**
   * **The one that matters.** The plan names a resource, and the run goes on to create exactly that set —
   * so a plan that has silently drifted from the work fails here rather than misleading an operator.
   *
   * The fixture is the drift: `ASSETS` is declined, so the plan built from the capabilities alone would
   * announce `replay-staging-assets` and the run would never create it. Both halves take the same Worker
   * set, which is the property under test — not that two identical calls agree.
   */
  test("names exactly the resources the run then creates", async () => {
    const plan = await provisionPlan({ projectDir: dir, project: "replay", scope, capabilities, workers: workers() });
    const report = await provisionEnvironment({
      projectDir: dir,
      scope,
      capabilities,
      provisioners: fakeProvisioners(),
      resolveWorkers: async () => workers(),
      ...noBackend,
    });

    expect(plan.resources.map((resource) => resource.name)).toEqual(["replay-staging-db", "replay-staging-cache"]);
    expect(plan.resources.map((resource) => resource.name)).toEqual(report.resources.map((resource) => resource.name));
    // Stated the other way as well, because the equality above would also hold if both were empty.
    expect(plan.resources.length).toBeGreaterThan(0);
    // And the declined bucket is in neither, which is the drift the fixture exists to produce.
    expect(plan.resources.map((resource) => resource.name)).not.toContain("replay-staging-assets");
  });

  test("names the Workers it will write, and the store entries it will reach", async () => {
    const plan = await provisionPlan({ projectDir: dir, project: "replay", scope, capabilities, workers: workers() });

    expect(plan.env).toBe("staging");
    expect(plan.project).toBe("replay");
    expect(plan.workers).toEqual(["replay-board"]);
    expect(plan.secrets).toEqual([
      "replay-staging-session-signing-key",
      // One account-level value every environment binds — never a per-environment copy of it.
      "replay-global-release-ingest-secret",
    ]);
    // A `d1` secret is sealed inside the environment's own database; no run reaches one from here.
    expect(plan.secrets.some((name) => name.includes("webhook"))).toBe(false);
  });

  /**
   * **A `▸` line per resource, and it arrives before that resource's result.** The pair is what an
   * interrupted run is read back from: the last `start` with no `settled` after it names what was in
   * flight when the run stopped.
   */
  test("narrates each resource, opening it before it settles", async () => {
    const events: string[] = [];
    await provisionEnvironment({
      projectDir: dir,
      scope,
      capabilities,
      provisioners: fakeProvisioners(),
      resolveWorkers: async () => workers(),
      onProgress: (event) =>
        events.push(event.phase === "start" ? `start ${event.name}` : `settled ${event.resource.name}`),
      ...noBackend,
    });

    expect(events).toEqual([
      "start replay-staging-db",
      "settled replay-staging-db",
      "start replay-staging-cache",
      "settled replay-staging-cache",
    ]);
  });

  /**
   * **A manifest that is present and will not parse, carried out of the run rather than dropped (#184).**
   *
   * `provisionTargets` read `composedManifests` for its manifests and discarded the `faults` half, which
   * `availableManifests` returns precisely so this is reportable. The cost is not a missing resource — the
   * bindings come from the composed capability — it is a **wrong** one: `scope` and `resource` live in
   * this file, so a project-global database is created per environment and the run says nothing, which is
   * #513's split reintroduced by a file nobody could open.
   */
  describe("a manifest that is installed and will not parse", () => {
    /** Break the fixture manifest in place, leaving the composed capability untouched. */
    async function breakManifest(): Promise<void> {
      await writeFile(join(dir, "node_modules", "@pithy-sh", "app", "pithy.manifest.json"), "{ not json");
    }

    test("is named in the plan the operator agrees to, before anything is created", async () => {
      await breakManifest();

      const plan = await provisionPlan({ projectDir: dir, project: "replay", scope, capabilities, workers: workers() });

      expect(plan.manifestFaults.map((fault) => fault.package)).toEqual(["@pithy-sh/app"]);
      expect(formatProvisionPlan(plan)).toContain("@pithy-sh/app: malformed pithy.manifest.json");
      // And the row it makes doubtful is still there, because the run still creates it — under whatever
      // name the generic rule composed once the declaration went unread.
      expect(formatProvisionPlan(plan)).toContain("replay-staging-db");
    });

    test("is named in the report of the run that went ahead anyway", async () => {
      await breakManifest();

      const report = await provisionEnvironment({
        projectDir: dir,
        scope,
        capabilities,
        provisioners: fakeProvisioners(),
        resolveWorkers: async () => workers(),
        ...noBackend,
      });

      expect(report.manifestFaults.map((fault) => fault.package)).toEqual(["@pithy-sh/app"]);
      expect(report.manifestFaults[0]?.reason).toContain("JSON");
    });

    test("is said once for a project whose Workers all see the same broken package", async () => {
      // Manifests resolve per Worker from two directories and every Worker sees the root's copy, so an
      // undeduped carry would say it once per Worker — three lines about one file.
      await breakManifest();
      const second = join(dir, "apps", "collab");
      await mkdir(second, { recursive: true });
      await writeFile(join(second, "wrangler.jsonc"), '{\n  "name": "replay-collab"\n}\n');

      const plan = await provisionPlan({
        projectDir: dir,
        project: "replay",
        scope,
        capabilities,
        workers: [...workers(), { name: "replay-collab", dir: second, capabilities: [app] }],
      });

      expect(plan.manifestFaults).toHaveLength(1);
    });

    test("a healthy install reports none, so the line is a finding rather than furniture", async () => {
      const plan = await provisionPlan({ projectDir: dir, project: "replay", scope, capabilities, workers: workers() });

      expect(plan.manifestFaults).toEqual([]);
      expect(formatProvisionPlan(plan)).not.toContain("malformed");
    });
  });

  test("says nothing at all when nobody is listening", async () => {
    // The `--json` shape of the same run: no sink, so `provisionEnvironment` narrates into nothing and
    // the report is the only output there has ever been.
    const report = await provisionEnvironment({
      projectDir: dir,
      scope,
      capabilities,
      provisioners: fakeProvisioners(),
      resolveWorkers: async () => workers(),
      ...noBackend,
    });

    expect(report.resources).toHaveLength(2);
  });
});

describe("formatProvisionPlan", () => {
  const plan = {
    project: "dash",
    env: "staging",
    resources: [
      { kind: "d1" as const, binding: "SUPPRESSIONS", name: "dash-global-email-suppressions" },
      { kind: "d1" as const, binding: "DB", name: "dash-staging-db" },
      { kind: "r2" as const, binding: "MEDIA", name: "dash-staging-media" },
    ],
    workers: ["board", "email"],
    secrets: ["auth-session-secret", "email-link-signing-key"],
    manifestFaults: [],
  };

  test("leads with the sentence, then one aligned row per group", () => {
    expect(formatProvisionPlan(plan)).toBe(
      [
        "Provisioning staging for dash.",
        "",
        "  databases  dash-global-email-suppressions, dash-staging-db",
        "  buckets    dash-staging-media",
        "  workers    board, email",
        "  secrets    auth-session-secret, email-link-signing-key",
      ].join("\n"),
    );
  });

  /**
   * **Non-TTY degrades to the same plain lines, never escape codes.** The row labels are dimmed as
   * section labels (docs/CLI.md §3.4), and the terminal seam latches color off the moment the output is
   * piped — which is every CI log, and every test. A plan carrying ANSI into a log file is the thing the
   * seam exists to prevent, and a spinner would carry cursor movement in with it.
   */
  test("carries no escape codes where there is no terminal to read them", () => {
    expect(formatProvisionPlan(plan)).not.toContain("\u001b");
  });

  test("a run with nothing provisionable still says which environment it is", () => {
    expect(
      formatProvisionPlan({
        project: "dash",
        env: "prod",
        resources: [],
        workers: [],
        secrets: [],
        manifestFaults: [],
      }),
    ).toBe("Provisioning prod for dash.");
  });
});

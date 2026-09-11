// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { packageInstalledFrom } from "../project/kitResolve";
import { type ComposedWorker, capabilityReachHealth } from "./capabilityReach";

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "pithy-capability-reach-"));
  await writeFile(join(dir, "package.json"), JSON.stringify({ name: "acme", type: "module" }));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

/**
 * Install a package where a resolver would find it — a `package.json` under `<base>/node_modules/<pkg>`.
 *
 * A `package.json` and not merely a directory, because that is what the check asks for and what
 * `manifests.ts` established the rule with: npm and bun both leave empty directories behind, and an empty
 * one is not an install.
 */
async function install(base: string, pkg: string, version = "0.2.2"): Promise<void> {
  const at = join(base, "node_modules", pkg);
  await mkdir(at, { recursive: true });
  await writeFile(join(at, "package.json"), JSON.stringify({ name: pkg, version }));
}

/** A Worker under `apps/<name>`, composing the named capabilities. */
async function worker(name: string, capabilities: string[]): Promise<ComposedWorker> {
  const workerDir = join(dir, "apps", name);
  await mkdir(workerDir, { recursive: true });
  return { name, dir: workerDir, capabilities: capabilities.map((capability) => ({ name: capability })) };
}

describe("capabilityReachHealth", () => {
  test("a capability installed at the project root is reachable, and the project stays ok", async () => {
    await install(dir, "@pithy-sh/payments");
    const health = await capabilityReachHealth(dir, [await worker("api", ["payments"])]);
    expect(health).toEqual({ ok: true, reachable: ["payments"], unreachable: [], split: [] });
  });

  /**
   * **The layout #533 was reported about, and the reason this is now a green line.**
   *
   * The Worker's `pithy.config.ts` is imported by path, so its own imports resolve from `apps/api/` and
   * the composition is perfect. Round two's resolver asked the **project root** alone, so every `pithy
   * payments …` command refused with *"the payments capability is not installed. Run `pithy add
   * payments`"* — a sentence that is wrong twice and whose action rewrites a hand-built config — and this
   * check reported the layout as a fault to explain it. `kitResolve` reaches a Worker's own
   * `node_modules` now, so the commands work and the report says so; a red line here would be doctor
   * telling an adopter to move an install that is fine.
   */
  test("a capability installed under the Worker that composes it is reachable", async () => {
    const api = await worker("api", ["payments"]);
    await install(api.dir, "@pithy-sh/payments");
    const health = await capabilityReachHealth(dir, [api]);
    expect(health).toEqual({ ok: true, reachable: ["payments"], unreachable: [], split: [] });
  });

  test("a capability installed nowhere is unreachable, and every composing Worker is named", async () => {
    const health = await capabilityReachHealth(dir, [await worker("api", ["payments"])]);
    expect(health.unreachable).toEqual([{ capability: "payments", package: "@pithy-sh/payments", workers: ["api"] }]);
    expect(health.ok).toBe(false);
  });

  /**
   * The check and the resolver ask one question, and this is the assertion that they do.
   *
   * They were two lookups for one round — a walk up from the root here, `kitResolve` there — and the
   * report existed *because* they disagreed. A capability the CLI can load and doctor calls unreachable is
   * the same defect wearing the other sign, so the two are pinned against each other rather than
   * separately.
   */
  test("what doctor calls reachable is what the resolver can find", async () => {
    const api = await worker("api", ["payments"]);
    await install(api.dir, "@pithy-sh/payments");
    expect(packageInstalledFrom(dir, "@pithy-sh/payments")).toBe(true);
    expect((await capabilityReachHealth(dir, [api])).reachable).toEqual(["payments"]);

    expect(packageInstalledFrom(dir, "@pithy-sh/vector")).toBe(false);
    expect((await capabilityReachHealth(dir, [await worker("collab", ["vector"])])).unreachable).toHaveLength(1);
  });

  /**
   * A directory with no `package.json` is not an install, on `manifests.ts`'s rule: npm and bun both leave
   * one behind, and a check that read the directory would call a removed package present.
   */
  test("an empty package directory is not an install", async () => {
    await mkdir(join(dir, "node_modules", "@pithy-sh", "payments"), { recursive: true });
    const health = await capabilityReachHealth(dir, [await worker("api", ["payments"])]);
    expect(health.ok).toBe(false);
  });

  /**
   * The resolution the CLI performs walks *up* from the project root, so a hoisting monorepo is healthy —
   * exactly as `createRequire(<projectDir>/package.json)` would find it.
   */
  test("a package hoisted above the project root is reachable, because that is where the CLI finds it", async () => {
    const nested = join(dir, "packages", "app");
    await mkdir(nested, { recursive: true });
    await writeFile(join(nested, "package.json"), JSON.stringify({ name: "app" }));
    await install(dir, "@pithy-sh/payments");
    const api = { name: "api", dir: join(nested, "apps", "api"), capabilities: [{ name: "payments" }] };
    await mkdir(api.dir, { recursive: true });
    expect((await capabilityReachHealth(nested, [api])).ok).toBe(true);
  });

  /**
   * **A capability the catalog does not name is the adopter's own, and is never reported.**
   *
   * Interpolating `@pithy-sh/<name>` onto an unknown name is how a project composing its own `billing`
   * capability — or its `app` capability, which every Worker composes — gets told a package that never
   * existed is missing.
   */
  test("a capability the catalog does not name is left alone", async () => {
    const health = await capabilityReachHealth(dir, [await worker("api", ["billing", "app"])]);
    expect(health).toEqual({ ok: true, reachable: [], unreachable: [], split: [] });
  });

  /** `controlplane` ships inside `@pithy-sh/core`, so the package comes from the catalog and not the name. */
  test("controlplane is looked for in @pithy-sh/core, where it actually ships", async () => {
    const missing = await capabilityReachHealth(dir, [await worker("api", ["controlplane"])]);
    expect(missing.unreachable[0]?.package).toBe("@pithy-sh/core");
    await install(dir, "@pithy-sh/core");
    expect((await capabilityReachHealth(dir, [await worker("api", ["controlplane"])])).ok).toBe(true);
  });

  test("one capability composed by two Workers is one finding naming both", async () => {
    const health = await capabilityReachHealth(dir, [
      await worker("api", ["payments"]),
      await worker("collab", ["payments"]),
    ]);
    expect(health.unreachable).toHaveLength(1);
    expect(health.unreachable[0]?.workers).toEqual(["api", "collab"]);
  });

  /** A Worker double with no composition is a Worker that composes nothing, never a hole in the report. */
  test("a Worker that reports no composition contributes nothing", async () => {
    const health = await capabilityReachHealth(dir, [{ name: "api", dir: join(dir, "apps", "api") }]);
    expect(health).toEqual({ ok: true, reachable: [], unreachable: [], split: [] });
  });
});

/**
 * **One capability, two versions across a project's Workers (#539).**
 *
 * The state is reachable and nothing refuses it: `kitResolve` takes the first `apps/*` match in directory
 * order, so `pithy payments provision` acting for `apps/api` builds its plan from api's manifest and
 * deploys admin's package, at exit 0. These are the assertions that `doctor` says so.
 */
describe("capabilityReachHealth — version skew", () => {
  test("two Workers holding different versions of one capability are one finding naming each", async () => {
    const api = await worker("api", ["payments"]);
    const admin = await worker("admin", ["payments"]);
    await install(api.dir, "@pithy-sh/payments", "5.9.9");
    await install(admin.dir, "@pithy-sh/payments", "5.0.0");

    const health = await capabilityReachHealth(dir, [api, admin]);
    expect(health.split).toEqual([
      {
        capability: "payments",
        package: "@pithy-sh/payments",
        at: [
          { worker: "api", version: "5.9.9" },
          { worker: "admin", version: "5.0.0" },
        ],
      },
    ]);
  });

  /**
   * **It reports and it does not fail the exit.**
   *
   * `unreachable` fails `ok` because every `pithy <capability>` command for it refuses today. Skew refuses
   * nothing, and a project legitimately mid-upgrade — one Worker bumped ahead of the other — must not read
   * as broken while it is being fixed.
   */
  test("skew does not fail ok, and the capability stays reachable", async () => {
    const api = await worker("api", ["payments"]);
    const admin = await worker("admin", ["payments"]);
    await install(api.dir, "@pithy-sh/payments", "5.9.9");
    await install(admin.dir, "@pithy-sh/payments", "5.0.0");

    const health = await capabilityReachHealth(dir, [api, admin]);
    expect(health.ok).toBe(true);
    expect(health.reachable).toEqual(["payments"]);
    expect(health.unreachable).toEqual([]);
  });

  /** One version installed twice is one version. Two copies of the same release are the same code. */
  test("two Workers holding the same version are not split", async () => {
    const api = await worker("api", ["payments"]);
    const admin = await worker("admin", ["payments"]);
    await install(api.dir, "@pithy-sh/payments", "5.0.0");
    await install(admin.dir, "@pithy-sh/payments", "5.0.0");
    expect((await capabilityReachHealth(dir, [api, admin])).split).toEqual([]);
  });

  /**
   * **A Worker with no copy of its own resolves the root's, and that is the version reported for it.**
   *
   * The per-Worker answer is a walk up from `apps/<name>` — Node's own, and the one the Worker's
   * `pithy.config.ts` gets when it is imported by path. So a hoisted copy beside one per-Worker install is
   * skew too, and it is the shape an interrupted `pithy add` leaves behind.
   */
  test("a Worker with no copy of its own is named with the version it inherits from the root", async () => {
    const api = await worker("api", ["payments"]);
    const admin = await worker("admin", ["payments"]);
    await install(dir, "@pithy-sh/payments", "5.0.0");
    await install(api.dir, "@pithy-sh/payments", "5.9.9");

    expect((await capabilityReachHealth(dir, [api, admin])).split).toEqual([
      {
        capability: "payments",
        package: "@pithy-sh/payments",
        at: [
          { worker: "api", version: "5.9.9" },
          { worker: "admin", version: "5.0.0" },
        ],
      },
    ]);
  });

  /** One Worker cannot disagree with itself. A single composer is never a split. */
  test("one Worker composing a capability is never split", async () => {
    const api = await worker("api", ["payments"]);
    await install(api.dir, "@pithy-sh/payments", "5.9.9");
    expect((await capabilityReachHealth(dir, [api])).split).toEqual([]);
  });

  /**
   * A capability installed nowhere has no version anywhere to disagree about, so it is reported once — as
   * unreachable — rather than twice. The gate in the walk is what says so; here it is the report content.
   */
  test("a capability installed nowhere is reported once, as unreachable", async () => {
    const health = await capabilityReachHealth(dir, [
      await worker("api", ["payments"]),
      await worker("admin", ["payments"]),
    ]);
    expect(health.unreachable).toHaveLength(1);
    expect(health.split).toEqual([]);
  });

  /**
   * **The version comes from the resolved package's own `package.json`, so a copy that declares none is
   * left out rather than guessed at.**
   *
   * A workspace link, a hand-made directory, a half-written install: each is a copy whose version nobody
   * can name. Reporting it as `unknown` beside a real one would put a version in front of an operator that
   * no package carries, and the whole point of reading the file is that the report names what would load.
   */
  test("a copy declaring no version contributes nothing to the comparison", async () => {
    const api = await worker("api", ["payments"]);
    const admin = await worker("admin", ["payments"]);
    await install(api.dir, "@pithy-sh/payments", "5.9.9");
    await mkdir(join(admin.dir, "node_modules", "@pithy-sh", "payments"), { recursive: true });
    await writeFile(
      join(admin.dir, "node_modules", "@pithy-sh", "payments", "package.json"),
      JSON.stringify({ name: "@pithy-sh/payments" }),
    );

    const health = await capabilityReachHealth(dir, [api, admin]);
    expect(health.split).toEqual([]);
  });

  /** Three Workers, three versions: one finding, every Worker on it, in report order. */
  test("three Workers at three versions are one finding", async () => {
    const api = await worker("api", ["payments"]);
    const admin = await worker("admin", ["payments"]);
    const jobs = await worker("jobs", ["payments"]);
    await install(api.dir, "@pithy-sh/payments", "5.9.9");
    await install(admin.dir, "@pithy-sh/payments", "5.0.0");
    await install(jobs.dir, "@pithy-sh/payments", "4.1.0");

    const health = await capabilityReachHealth(dir, [api, admin, jobs]);
    expect(health.split).toHaveLength(1);
    expect(health.split[0]?.at).toEqual([
      { worker: "api", version: "5.9.9" },
      { worker: "admin", version: "5.0.0" },
      { worker: "jobs", version: "4.1.0" },
    ]);
  });

  /**
   * A capability the catalog does not name is the adopter's own, and there is no `@pithy-sh/<name>` to
   * compare versions of. The same rule the unreachable branch follows, for the same reason.
   */
  test("a capability the catalog does not name is never compared", async () => {
    const api = await worker("api", ["billing"]);
    const admin = await worker("admin", ["billing"]);
    await install(api.dir, "@pithy-sh/billing", "5.9.9");
    await install(admin.dir, "@pithy-sh/billing", "5.0.0");
    expect((await capabilityReachHealth(dir, [api, admin])).split).toEqual([]);
  });

  /** A `package.json` that will not parse is a copy nothing can read a version off. It is not a guess. */
  test("a copy whose package.json will not parse contributes nothing", async () => {
    const api = await worker("api", ["payments"]);
    const admin = await worker("admin", ["payments"]);
    await install(api.dir, "@pithy-sh/payments", "5.9.9");
    await mkdir(join(admin.dir, "node_modules", "@pithy-sh", "payments"), { recursive: true });
    await writeFile(join(admin.dir, "node_modules", "@pithy-sh", "payments", "package.json"), "{ not json");

    expect((await capabilityReachHealth(dir, [api, admin])).split).toEqual([]);
  });
});

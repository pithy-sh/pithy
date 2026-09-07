// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CapabilityManifest } from "@pithy-sh/core/src/capability/manifest";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { DEFAULT_WORKER, scaffoldProject } from "../project/scaffold";
import { buildReconcilePlan } from "./reconcile";

/**
 * A capability declared **only** on the Worker that composes it (#507).
 *
 * `buildReconcilePlan` resolved every manifest from `<root>/node_modules/@pithy-sh/*`. That worked for as
 * long as every project had the root copy, and every project did, because `pithy add` writes the
 * capability to both manifests. So the root declaration was load-bearing and nothing said so.
 *
 * It stops being true in the shape the kit tells adopters to adopt. Capabilities are per-Worker — the
 * config importing them is the Worker's, so the dependency is the Worker's — and a project that declares
 * one only there installs it under `apps/<name>/node_modules`, where the root scan never looks.
 *
 * **A manifest that does not resolve is not an error, it is a skip**, and every loop in the plan is keyed
 * on the manifests: bindings go unchecked, config options unread, generated values uncompared. The one
 * that made this urgent is `missingPrerequisites`, which answered **`ok` for a composition genuinely
 * missing a required peer** — not narrowed advice but a wrong answer, on the check an adopter reads before
 * deploying, indistinguishable from health.
 *
 * ## Why this file exists rather than a case in a neighboring suite
 *
 * Every other fixture writes its manifests to the project root, because that is what a scaffold produces —
 * which is exactly why none of them could fail. Reaching this shape means placing a manifest under the
 * Worker and **nowhere else**, and that placement is the whole test. `writeWorkerOnly` does it in one
 * function so the arrangement cannot quietly drift back to the root and take the assertion with it.
 */

/** A capability that needs a peer — the shape whose absence must be reported. */
const NEEDS_PEER = CapabilityManifest.parse({
  name: "needy",
  package: "@pithy-sh/needy",
  requiredBindings: [{ type: "d1", name: "DB" }],
  peerCapabilities: ["absent"],
});

describe("a capability declared only on the Worker that composes it", () => {
  let dir: string;
  let worker: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "pithy-worker-declared-"));
    await scaffoldProject({ targetDir: dir, appName: "declared" });
    worker = join(dir, "apps", DEFAULT_WORKER);
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  /** Place a manifest under the Worker's own `node_modules`, and deliberately not under the root's. */
  async function writeWorkerOnly(manifest: CapabilityManifest): Promise<void> {
    const pkgDir = join(worker, "node_modules", "@pithy-sh", manifest.name);
    await mkdir(pkgDir, { recursive: true });
    await writeFile(join(pkgDir, "pithy.manifest.json"), JSON.stringify(manifest));
  }

  /** Place one under the project root's, the way a scaffolded project has always had it. */
  async function writeRootOnly(manifest: CapabilityManifest): Promise<void> {
    const pkgDir = join(dir, "node_modules", "@pithy-sh", manifest.name);
    await mkdir(pkgDir, { recursive: true });
    await writeFile(join(pkgDir, "pithy.manifest.json"), JSON.stringify(manifest));
  }

  const planFor = (manifest: CapabilityManifest) =>
    buildReconcilePlan({
      account: null,
      projectDir: dir,
      workerDir: worker,
      env: "dev",
      capabilities: [{ name: manifest.name, requiredBindings: manifest.requiredBindings }] as never,
      workerConfig: { capabilities: [] } as never,
    });

  // The half that is a wrong answer rather than a missing one, and the reason this is gated at all.
  test("its missing peer is reported, rather than the project reading as healthy", async () => {
    await writeWorkerOnly(NEEDS_PEER);

    const plan = await planFor(NEEDS_PEER);

    expect(plan.missingPrerequisites).toEqual([{ capability: "needy", requires: "absent" }]);
  });

  // The control, and it is not decoration: without it a fix that merely stopped reading the root would
  // pass the test above while breaking every project that has the root copy — which is all of them.
  test("and a root-declared one is still read, because that is what every existing project has", async () => {
    await writeRootOnly(NEEDS_PEER);

    const plan = await planFor(NEEDS_PEER);

    expect(plan.missingPrerequisites).toEqual([{ capability: "needy", requires: "absent" }]);
  });

  // The floor. Both assertions above are about a manifest being *found*, so a fixture that never placed
  // one — or a plan that reported prerequisites for something nobody composed — would satisfy them for the
  // wrong reason. A capability with no manifest anywhere is the state that must stay silent.
  test("a capability with no manifest anywhere contributes nothing", async () => {
    const plan = await planFor(NEEDS_PEER);

    expect(plan.missingPrerequisites).toEqual([]);
  });
});

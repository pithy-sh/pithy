// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { CloudflareClients } from "@pithy-sh/cloudflare/src/client/clients";
import { loadCloudflareEnv } from "@pithy-sh/cloudflare/src/env/devVars";
import { reapStaleTestResources, uniqueName } from "@pithy-sh/cloudflare/src/test-utils/harness";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { deployProject } from "./deploy";

/**
 * `pithy deploy` across **several Workers**, against live Cloudflare.
 *
 * The unit suite proves the orchestration with a stubbed runner; what it cannot prove is that two Workers
 * under `apps/` each deploy as their **own script**, from their own directory and their own
 * `wrangler.jsonc`. That is the whole claim of the per-Worker layout on the deploy side, and it only holds
 * against the real wrangler and the real API.
 *
 * **This creates real Worker deployments.** They are named under the reserved `pithy-int-` namespace and
 * deleted in `afterAll` unconditionally — a failed assertion still tears them down — and the teardown
 * reports loudly if a delete fails, because a leaked Worker is a live endpoint.
 *
 * **One credential source governs the whole run.** The fixture carries its own `.dev.vars`, written from the
 * credentials the assertions and the teardown use, so `deployProject` — which resolves credentials from the
 * *project directory* it is given — cannot end up in a different account than the one this file addresses.
 * It is also the realistic shape: a real Pithy project root has a `.dev.vars`. Without it the loader falls
 * through to `process.env`, and a shell exporting another `CLOUDFLARE_ACCOUNT_ID` split the run in two —
 * wrangler uploaded to one account while the existence check and the `DELETE` addressed another, so the
 * assertion 404'd and every teardown was a silently tolerated 404. That leaked eight live Workers.
 *
 * Gated on credentials; with none present the whole suite skips. The fixture lives **inside the package**
 * (not the OS tmpdir) so `bun x wrangler` resolves the workspace's own wrangler instead of downloading one,
 * matching `e2e.test.ts`.
 */

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const packageRoot = path.join(__dirname, "..", "..");
const vars = loadCloudflareEnv(packageRoot);
const accountId = vars.CLOUDFLARE_ACCOUNT_ID ?? "";
const apiToken = vars.CLOUDFLARE_API_TOKEN ?? "";
const hasCreds = Boolean(accountId && apiToken);

const WORKERS = ["api", "web"] as const;
type Worker = (typeof WORKERS)[number];

/**
 * One reserved, run-unique script name per worker, minted once so `wrangler.jsonc`, the assertions, and
 * teardown all name the same thing.
 *
 * Through `uniqueName`, so a deploy this run cannot collide with a concurrent one *and* — the part that
 * matters — an interrupted run leaves a script the reaper recognises. These are live endpoints on a real
 * account; the previous `pithyit-dep-…` naming was neither reserved nor reapable, so a run killed before
 * `afterAll` left one serving traffic until somebody noticed it in the dashboard.
 */
const SCRIPTS = new Map<Worker, string>(WORKERS.map((worker) => [worker, uniqueName(`deploy-${worker}`)]));
const scriptName = (worker: Worker): string => SCRIPTS.get(worker) ?? worker;

/** A Worker with no imports — wrangler bundles it as-is, so the fixture needs no dependency resolution. */
const ENTRY = `export default {
  async fetch() {
    return new Response("ok");
  },
};
`;

function wranglerFor(worker: Worker): string {
  return `${JSON.stringify(
    { name: scriptName(worker), main: "src/index.ts", compatibility_date: "2026-06-01" },
    null,
    2,
  )}\n`;
}

/**
 * The Workers script API, addressed with **the run's one credential pair** — the same pair the fixture's
 * `.dev.vars` hands wrangler. Raw `fetch` rather than `CloudflareWorkersManager` for the per-run checks:
 * this is the independent observation that the deploy really landed, and teardown must not depend on the
 * client the product uses to reach the same endpoint.
 */
const scriptsUrl = `https://api.cloudflare.com/client/v4/accounts/${accountId}/workers/scripts`;
const authHeaders = { Authorization: `Bearer ${apiToken}` };

/** Whether the account this run is pinned to currently serves this script. */
async function scriptExists(name: string): Promise<boolean> {
  return (await fetch(`${scriptsUrl}/${name}`, { headers: authHeaders })).ok;
}

/** Script names the deploy reported as shipped — what turns a teardown 404 from "never made" into a leak. */
const deployed = new Set<string>();

/**
 * Delete a deployed script, and **prove it is gone**.
 *
 * A bare 404-tolerant delete is the right shape for idempotent product teardown and the wrong shape here.
 * It is precisely what hid the account split: wrangler had shipped the script somewhere else, so the
 * `DELETE` found nothing, reported success, and left a live endpoint behind. So the two cases are
 * separated — a script this run deployed **must** be here, and after the delete it must be gone.
 */
async function removeScript(name: string): Promise<void> {
  const response = await fetch(`${scriptsUrl}/${name}?force=true`, { method: "DELETE", headers: authHeaders });
  if (!response.ok && response.status !== 404) {
    throw new Error(`delete ${name} failed: ${response.status} ${await response.text()}`);
  }
  if (response.status === 404 && deployed.has(name)) {
    throw new Error(
      `${name} deployed but is absent from account ${accountId}: it was created in some other account and is still live. ` +
        "The deploy and this teardown resolved different credentials — check CLOUDFLARE_ACCOUNT_ID in the environment against the fixture's .dev.vars.",
    );
  }
  // Confirm, rather than trust the status code — a leaked Worker serves traffic.
  if (await scriptExists(name)) throw new Error(`${name} survived its delete and is still live on ${accountId}.`);
}

let projectDir: string | null = null;

beforeAll(async () => {
  // A run killed before `afterAll` — a timeout, a Ctrl-C, a crash — orphans live endpoints, so each run
  // clears the last one's debris. Only `pithy-int-` names older than the harness's 12h window, so a
  // concurrent suite's scripts are never in range.
  if (!hasCreds) return;
  const workers = new CloudflareClients({ accountId, apiToken }).workers();
  await reapStaleTestResources({
    label: "Worker script",
    list: async () => (await workers.listWorkers()).map((script) => script.id ?? "").filter(Boolean),
    remove: (name) => workers.deleteWorker(name),
  });
});

afterAll(async () => {
  // Unconditional. A leaked Worker is a live endpoint on the account, so a cleanup failure is shouted,
  // not swallowed — even though a test failure has already been reported.
  if (hasCreds) {
    for (const worker of WORKERS) {
      await removeScript(scriptName(worker)).catch((error: unknown) => {
        console.error(`deploy teardown failed for ${scriptName(worker)} — delete it by hand:`, error);
      });
    }
  }
  if (projectDir) await rm(projectDir, { recursive: true, force: true });
});

describe.skipIf(!hasCreds)("deploy across workers — LIVE", () => {
  test("each worker deploys as its own script, from its own wrangler.jsonc", { timeout: 600_000 }, async () => {
    const dir = await mkdtemp(path.join(packageRoot, ".deploy-it-"));
    projectDir = dir;
    // The fixture is a project root, and a project root carries its credentials. Written before anything
    // runs, so `deployProject` resolves *these* — not whatever the ambient environment happens to say.
    await writeFile(
      path.join(dir, ".dev.vars"),
      `CLOUDFLARE_ACCOUNT_ID="${accountId}"\nCLOUDFLARE_API_TOKEN="${apiToken}"\n`,
      { mode: 0o600 },
    );
    for (const worker of WORKERS) {
      const workerDir = path.join(dir, "apps", worker);
      await mkdir(path.join(workerDir, "src"), { recursive: true });
      await writeFile(path.join(workerDir, "wrangler.jsonc"), wranglerFor(worker));
      await writeFile(path.join(workerDir, "src", "index.ts"), ENTRY);
    }

    // The property the rest of this test rests on: the credentials the deploy will resolve from the
    // fixture are the credentials the assertions and the teardown address. Asserted, not assumed —
    // when it was merely assumed, it was false, and the suite leaked real Workers for four runs.
    const forDeploy = loadCloudflareEnv(dir);
    expect(forDeploy.CLOUDFLARE_ACCOUNT_ID).toBe(accountId);
    expect(forDeploy.CLOUDFLARE_API_TOKEN).toBe(apiToken);

    const deploys = await deployProject({ projectDir: dir });
    // Recorded before any assertion can throw, so teardown knows what must exist.
    for (const deploy of deploys) if (deploy.ok) deployed.add(deploy.name);

    // Both were attempted — discovery found each apps/<name>, not one merged project.
    expect(deploys).toHaveLength(WORKERS.length);
    const failures = deploys.filter((deploy) => !deploy.ok);
    expect(failures.map((f) => `${f.name}: ${f.error}`)).toEqual([]);

    // Each reports under its own script name, and they are distinct — the per-Worker claim.
    expect(deploys.map((deploy) => deploy.name).sort()).toEqual(WORKERS.map(scriptName).sort());
    expect(new Set(deploys.map((deploy) => deploy.versionId)).size).toBe(WORKERS.length);

    // And the scripts genuinely exist on the account now, not just in wrangler's output.
    for (const worker of WORKERS) {
      expect(await scriptExists(scriptName(worker)), `${scriptName(worker)} should exist after deploy`).toBe(true);
    }
  });
});

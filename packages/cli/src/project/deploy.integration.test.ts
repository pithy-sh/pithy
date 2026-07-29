import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadCloudflareEnv } from "@pithy-sh/cloudflare/src/env/devVars";
import { afterAll, describe, expect, test } from "vitest";
import { deployProject } from "./deploy";

/**
 * `pithy deploy` across **several Workers**, against live Cloudflare.
 *
 * The unit suite proves the orchestration with a stubbed runner; what it cannot prove is that two Workers
 * under `apps/` each deploy as their **own script**, from their own directory and their own
 * `wrangler.jsonc`. That is the whole claim of the per-Worker layout on the deploy side, and it only holds
 * against the real wrangler and the real API.
 *
 * **This creates real Worker deployments.** They are named under a `pithyit-` prefix and deleted in
 * `afterAll` unconditionally — a failed assertion still tears them down — and the teardown reports loudly
 * if a delete fails, because a leaked Worker is a live endpoint.
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

/** Run-unique so an interrupted run cannot collide with this one, and two runs can overlap. */
const RUN = `pithyit-dep-${Date.now().toString(36).slice(-6)}`;
const WORKERS = ["api", "web"] as const;
const scriptName = (worker: string) => `${RUN}-${worker}`;

/** A Worker with no imports — wrangler bundles it as-is, so the fixture needs no dependency resolution. */
const ENTRY = `export default {
  async fetch() {
    return new Response("ok");
  },
};
`;

function wranglerFor(worker: string): string {
  return `${JSON.stringify(
    { name: scriptName(worker), main: "src/index.ts", compatibility_date: "2026-06-01" },
    null,
    2,
  )}\n`;
}

/** Delete a deployed script. Idempotent: a 404 means it was never created, or is already gone. */
async function deleteScript(name: string): Promise<void> {
  const url = `https://api.cloudflare.com/client/v4/accounts/${accountId}/workers/scripts/${name}?force=true`;
  const response = await fetch(url, { method: "DELETE", headers: { Authorization: `Bearer ${apiToken}` } });
  if (!response.ok && response.status !== 404) {
    throw new Error(`delete ${name} failed: ${response.status} ${await response.text()}`);
  }
}

let projectDir: string | null = null;

afterAll(async () => {
  // Unconditional. A leaked Worker is a live endpoint on the account, so a cleanup failure is shouted,
  // not swallowed — even though a test failure has already been reported.
  if (hasCreds) {
    for (const worker of WORKERS) {
      await deleteScript(scriptName(worker)).catch((error: unknown) => {
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
    for (const worker of WORKERS) {
      const workerDir = path.join(dir, "apps", worker);
      await mkdir(path.join(workerDir, "src"), { recursive: true });
      await writeFile(path.join(workerDir, "wrangler.jsonc"), wranglerFor(worker));
      await writeFile(path.join(workerDir, "src", "index.ts"), ENTRY);
    }

    const deploys = await deployProject({ projectDir: dir });

    // Both were attempted — discovery found each apps/<name>, not one merged project.
    expect(deploys).toHaveLength(WORKERS.length);
    const failures = deploys.filter((deploy) => !deploy.ok);
    expect(failures.map((f) => `${f.name}: ${f.error}`)).toEqual([]);

    // Each reports under its own script name, and they are distinct — the per-Worker claim.
    expect(deploys.map((deploy) => deploy.name).sort()).toEqual(WORKERS.map(scriptName).sort());
    expect(new Set(deploys.map((deploy) => deploy.versionId)).size).toBe(WORKERS.length);

    // And the scripts genuinely exist on the account now, not just in wrangler's output.
    for (const worker of WORKERS) {
      const response = await fetch(
        `https://api.cloudflare.com/client/v4/accounts/${accountId}/workers/scripts/${scriptName(worker)}`,
        { headers: { Authorization: `Bearer ${apiToken}` } },
      );
      expect(response.ok, `${scriptName(worker)} should exist after deploy`).toBe(true);
    }
  });
});

// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { CloudflareClients } from "@pithy-sh/cloudflare/src/client/clients";
import { RESERVED_TEST_PROJECT } from "@pithy-sh/cloudflare/src/test-utils/harness";
import { defineCapability } from "@pithy-sh/core/src/capability/capability";
import { FEATURE_ENVIRONMENT } from "@pithy-sh/core/src/naming/environment";
import { featureResourceName, featureWorkerName } from "@pithy-sh/core/src/naming/feature";
import { parse } from "comment-json";
import { afterAll, describe, expect, test } from "vitest";
import { cloudflareEnv } from "../cloudflare/config";
import { buildEnvInventory } from "../project/envInventory";
import { cloudflareProvisioners } from "../provision/resources";
import { destroyFeature } from "./destroy";
import { provisionFeature } from "./provision";

/**
 * The feature lifecycle against **live Cloudflare** — the one path unit tests cannot cover, because
 * the whole point is that real resources are created, written into each Worker's own
 * `wrangler.jsonc`, and then deleted again.
 *
 * It exists to prove the per-Worker layout's central claim end to end: **two Workers that declare the
 * same binding name share one real resource, and a Worker that declares its own gets its own.** That
 * is asserted here against actual D1/KV ids, not fixtures.
 *
 * Setup/teardown is the shape of the test. `provision` creates; the assertions read what landed in
 * each Worker's config; `destroy` removes it. Teardown runs in `afterAll` **unconditionally**, so a
 * failed assertion still deletes what was created rather than leaking resources into the account.
 *
 * Gated on credentials (`<config>/cloudflare.json` or the environment). With none present the whole suite
 * skips —
 * it never half-runs.
 */

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const vars = cloudflareEnv({ account: null });
const accountId = vars.CLOUDFLARE_ACCOUNT_ID ?? "";
const apiToken = vars.CLOUDFLARE_API_TOKEN ?? "";
const hasCreds = Boolean(accountId && apiToken);

/** The feature environment these resources are created under. */
const ENV = FEATURE_ENVIRONMENT;

/**
 * A run-unique slug, so a leftover from an interrupted run can never collide with this one and two
 * runs can overlap safely. Kept short — it is a segment of every resource name.
 */
const SLUG = `it${Date.now().toString(36).slice(-6)}`;

/**
 * Provisioned under the **reserved test project**, not an invented one.
 *
 * These names are the thing under test, so they cannot route through `uniqueName` — `featureResourceName`
 * has to compose them. But the project segment comes first and verbatim, so naming the project
 * `pithy-int-test` puts every resource this suite creates inside the reserved namespace anyway. The old
 * `pithyit` was a name a real adopter could legitimately choose, which is exactly the collision the
 * reservation exists to make impossible.
 */
const IDENTITY = { project: RESERVED_TEST_PROJECT, issue: "73", slug: SLUG } as const;

/** Both Workers declare `DB`; only collab declares `ROOMS`. That asymmetry is what the test proves. */
const shared = defineCapability({
  name: "sharedstore",
  requiredBindings: [{ type: "d1", name: "DB" }],
});
const collabOnly = defineCapability({
  name: "collabstore",
  requiredBindings: [
    { type: "d1", name: "DB" },
    { type: "kv", name: "ROOMS" },
  ],
});

/** A minimal wrangler.jsonc for one Worker in the fixture project. */
function wranglerFor(name: string): string {
  return `${JSON.stringify(
    {
      name,
      main: "src/index.ts",
      compatibility_date: "2026-06-01",
      d1_databases: [],
      kv_namespaces: [],
    },
    null,
    2,
  )}\n`;
}

/** Build a two-Worker project on disk: apps/api and apps/collab, each with its own wrangler.jsonc. */
async function buildProject(): Promise<{ dir: string }> {
  const dir = await mkdtemp(path.join(tmpdir(), "pithy-lifecycle-"));
  // A project root carries its credentials, and here that is load-bearing rather than decoration:
  // `buildEnvInventory` resolves the account from the *project directory* it is given, while provisioning
  // and teardown use the clients built above. Without this file the loader falls through to `process.env`,
  // so a shell exporting another CLOUDFLARE_ACCOUNT_ID makes `pithy env` report an account nothing in this
  // run touched — one suite, two accounts. One source, written once, governs the whole run.
  await writeFile(
    path.join(dir, ".dev.vars"),
    `CLOUDFLARE_ACCOUNT_ID="${accountId}"\nCLOUDFLARE_API_TOKEN="${apiToken}"\n`,
    { mode: 0o600 },
  );
  for (const name of ["api", "collab"]) {
    const workerDir = path.join(dir, "apps", name);
    await mkdir(path.join(workerDir, "src"), { recursive: true });
    await writeFile(path.join(workerDir, "wrangler.jsonc"), wranglerFor(name));
    await writeFile(path.join(workerDir, "src", "index.ts"), "export default {};\n");
  }
  return { dir };
}

/**
 * A git runner for the teardown half of `destroyFeature`.
 *
 * The fixture is a bare temp directory, not a real worktree, but `destroyFeature` always finishes by
 * pruning one — and `mainRepoRoot` throws outright if `git worktree list` yields nothing. So the stub
 * answers that one query with a path that is registered nowhere, which makes every later step a
 * no-op, and returns empty for everything else. The point of this test is the **remote** teardown;
 * worktree plumbing is unit-tested separately and must not touch this machine's real repository.
 */
const stubGit = async (args: string[]): Promise<string> =>
  args[0] === "worktree" && args[1] === "list" ? `worktree ${path.join(tmpdir(), "pithy-not-a-worktree")}\n` : "";

/** The `env.<ENV>` stanza a Worker's wrangler.jsonc carries after provisioning. */
interface EnvStanza {
  name?: string;
  d1_databases?: { binding: string; database_id?: string }[];
  kv_namespaces?: { binding: string; id?: string }[];
  services?: { binding: string; service: string }[];
}

/** Read one Worker's provisioned `env.<ENV>` stanza back off disk. */
async function readEnvStanza(workerDir: string): Promise<EnvStanza> {
  const raw = await readFile(path.join(workerDir, "wrangler.jsonc"), "utf8");
  const config = parse(raw) as unknown as { env?: Record<string, EnvStanza | undefined> };
  return config.env?.[ENV] ?? {};
}

// State shared between the test and the teardown, so cleanup runs even when an assertion throws.
let projectDir: string | null = null;

const clients = hasCreds ? new CloudflareClients({ accountId, apiToken }) : null;
const provisioners = clients ? cloudflareProvisioners(clients, { accountId, confirmation: "pinned" }) : null;
const capabilities = [shared, collabOnly];

afterAll(async () => {
  // Unconditional: a failed assertion must not leak real D1/KV into the account. `destroyFeature`
  // recomputes the same names from the identity, so it deletes exactly what provision created.
  if (projectDir && provisioners) {
    await destroyFeature({
      projectDir,
      identity: IDENTITY,
      capabilities,
      env: ENV,
      provisioners,
      git: stubGit,
      registryPath: path.join(projectDir, ".dev-ports.json"),
    }).catch((error: unknown) => {
      // Surface a cleanup failure loudly: a leaked resource costs money and blocks the next run.
      console.error("lifecycle teardown failed — check the account for leftovers:", error);
    });
  }
  if (projectDir) await rm(projectDir, { recursive: true, force: true });
});

describe.skipIf(!hasCreds)("feature lifecycle — LIVE", () => {
  test("provision creates one shared database for a shared binding, and per-Worker resources for the rest", {
    timeout: 300_000,
  }, async () => {
    const built = await buildProject();
    projectDir = built.dir;
    if (!provisioners) throw new Error("unreachable: suite is credential-gated");

    const report = await provisionFeature({
      projectDir: built.dir,
      capabilities,
      identity: IDENTITY,
      provisioners,
      // api composes only the shared capability; collab composes both — so only collab declares ROOMS.
      resolveWorkers: async () => [
        { name: "api", dir: path.join(built.dir, "apps", "api"), capabilities: [shared] },
        { name: "collab", dir: path.join(built.dir, "apps", "collab"), capabilities: [collabOnly] },
      ],
      // The backend runners are seams precisely so this test stays about provisioning and wiring;
      // migrating and seeding a live D1 is covered elsewhere and would only add minutes here.
      migrate: async () => {},
      seed: async () => {},
    });

    // One resource per *binding*, not per Worker — DB is declared by both and must appear once.
    const dbName = featureResourceName(IDENTITY, "DB", "d1");
    const roomsName = featureResourceName(IDENTITY, "ROOMS", "kv");
    expect(report.resources.filter((resource) => resource.name === dbName)).toHaveLength(1);
    expect(report.resources.map((resource) => resource.name)).toContain(roomsName);

    const api = await readEnvStanza(path.join(built.dir, "apps", "api"));
    const collab = await readEnvStanza(path.join(built.dir, "apps", "collab"));

    // Each Worker's own wrangler.jsonc carries the ids — the per-Worker layout's core promise.
    const apiDb = api.d1_databases?.find((entry) => entry.binding === "DB")?.database_id;
    const collabDb = collab.d1_databases?.find((entry) => entry.binding === "DB")?.database_id;
    expect(apiDb).toBeTruthy();
    expect(collabDb).toBeTruthy();

    // THE ASSERTION THIS TEST EXISTS FOR: same binding name → the same real database, live.
    expect(collabDb).toBe(apiDb);

    // A binding only collab declares is provisioned, and lands in collab alone.
    expect(collab.kv_namespaces?.find((entry) => entry.binding === "ROOMS")?.id).toBeTruthy();
    // A Worker gets only the bindings its own config declares — api never asked for ROOMS, so its
    // wrangler config must not carry it, live.
    expect(api.kv_namespaces?.some((entry) => entry.binding === "ROOMS")).toBeFalsy();

    // Each Worker deploys under its feature-scoped script name.
    expect(api.name).toBe(featureWorkerName(IDENTITY, "api"));
    expect(collab.name).toBe(featureWorkerName(IDENTITY, "collab"));
  });

  test("env reads back exactly what provision wrote, with real ids and links", { timeout: 120_000 }, async () => {
    // `pithy env`'s whole job is reporting what is actually out there. Fixtures can only prove it parses
    // its own invented wrangler.jsonc; this proves it reads real, provisioned Cloudflare ids — resolved
    // from the live account — and reports them as provisioned with the right dashboard links.
    if (!projectDir) throw new Error("unreachable: suite is credential-gated");

    // `account: null` because this fixture names none: it is a scratch project on a machine with one
    // account, which is the ordinary case and the state the unnamed credentials file exists for (#226).
    const inventory = await buildEnvInventory({ projectDir, account: null });

    // The account it reports is the account this run actually provisioned in — the fixture's own
    // `.dev.vars`, not whatever the ambient environment says.
    expect(inventory.accountId).toBe(accountId);
    // Both Workers appear, each read from its own wrangler.jsonc.
    expect(inventory.workers.map((worker) => worker.worker).sort()).toEqual(["api", "collab"]);

    const featureEnv = (worker: string) =>
      inventory.workers.find((entry) => entry.worker === worker)?.environments.find((env) => env.name === ENV);

    const apiDb = featureEnv("api")?.resources.find((resource) => resource.binding === "DB");
    const collabDb = featureEnv("collab")?.resources.find((resource) => resource.binding === "DB");

    // The shared database reports as provisioned for both Workers, under one real id.
    expect(apiDb?.provisioned).toBe(true);
    expect(collabDb?.id).toBe(apiDb?.id);
    // And the link is the real deep link for that database, not a guess.
    expect(apiDb?.dashboardUrl).toBe(
      `https://dash.cloudflare.com/${accountId}/workers/d1/databases/${apiDb?.id}/metrics`,
    );

    // collab's own KV is provisioned and linked; api never declared it, so it is absent there.
    const rooms = featureEnv("collab")?.resources.find((resource) => resource.binding === "ROOMS");
    expect(rooms?.provisioned).toBe(true);
    expect(rooms?.dashboardUrl).toBe(
      `https://dash.cloudflare.com/${accountId}/workers/kv/namespaces/${rooms?.id}/metrics`,
    );
    expect(featureEnv("api")?.resources.some((resource) => resource.binding === "ROOMS")).toBe(false);
  });

  test("destroy removes what provision created, and is idempotent on a second run", { timeout: 300_000 }, async () => {
    if (!projectDir || !provisioners) throw new Error("unreachable: suite is credential-gated");

    const teardown = {
      projectDir,
      identity: IDENTITY,
      capabilities,
      env: ENV,
      provisioners,
      git: stubGit,
      registryPath: path.join(projectDir, ".dev-ports.json"),
    };

    const first = await destroyFeature(teardown);
    expect(first.deleted.map((resource) => resource.name)).toContain(featureResourceName(IDENTITY, "DB", "d1"));

    // Re-running finds nothing left and still exits clean — teardown is safe to repeat in CI.
    const second = await destroyFeature(teardown);
    expect(second.deleted).toHaveLength(0);
  });
});

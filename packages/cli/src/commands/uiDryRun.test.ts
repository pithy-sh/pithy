// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runCommand } from "citty";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { Plan } from "../plan/plan";
import { scaffoldProject } from "../project/scaffold";
import { recorder } from "../test-utils/cloudflareRecorder";
import { linkKitPackages } from "../test-utils/linkKit";
import { captureStdout, commandAt, expectConforms, runCaptured } from "../test-utils/payloadContract";
import { snapshotTree } from "../test-utils/treeSnapshot";

/**
 * **`pithy ui add --dry-run` writes nothing and calls nothing that writes (#697)** — the real command in a
 * scaffolded project, Cloudflare replaced by a recorder and the network by a refusal. The flow's half,
 * that the plan is the real write's, is `ui/flow.test.ts`'s.
 */

const cloudflare = vi.hoisted(() => ({ current: undefined as unknown as { clients: () => Promise<unknown> } }));
vi.mock("../cloudflare/clients", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../cloudflare/clients")>()),
  cloudflareClients: () => cloudflare.current.clients(),
}));

let dir: string;
let account: ReturnType<typeof recorder>;
const fetched: string[] = [];
const FLAGS = ["react", "--no-auth", "--no-payments", "--no-organization", "--dry-run"];

beforeEach(async () => {
  account = recorder();
  cloudflare.current = account;
  fetched.length = 0;
  vi.spyOn(globalThis, "fetch").mockImplementation(async (url) => {
    fetched.push(String(url));
    throw new Error("A dry run reached the network.");
  });
  vi.stubEnv("CLOUDFLARE_ACCOUNT_ID", "acct");
  vi.stubEnv("CLOUDFLARE_API_TOKEN", "tok");
  dir = await mkdtemp(join(tmpdir(), "pithy-ui-dry-"));
  await scaffoldProject({ targetDir: dir, appName: "acme", worker: "api" });
  await linkKitPackages(dir, ["core"]);
  vi.spyOn(process, "cwd").mockReturnValue(dir);
});

afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  await rm(dir, { recursive: true, force: true });
});

describe("pithy ui add --dry-run", () => {
  test("--json: the published payload with its plan, nothing written, nothing that writes called", async () => {
    const before = await snapshotTree(dir);
    const written = await runCaptured("ui add", [...FLAGS, "--json"]);

    await expectConforms("ui add", written);
    const payload = JSON.parse(written.join(""));
    expect(payload).toMatchObject({ command: "ui.add", dryRun: true, worker: "api", framework: "react" });
    const plan = Plan.parse(payload.plan);
    expect(plan.files.find((file) => file.path === "apps/api/wrangler.jsonc")?.diff).toContain("run_worker_first");
    expect(plan.files.filter((file) => file.action === "create").length).toBe(payload.created.length);
    expect(await snapshotTree(dir)).toEqual(before);
    expect(account.writes).toEqual([]);
    expect(fetched).toEqual([]);
  });

  test("text: the plan, then the dry-run line in place of Done.", async () => {
    const before = await snapshotTree(dir);
    const written = captureStdout();
    await runCommand(await commandAt("ui add"), { rawArgs: FLAGS });
    const lines = written.join("").trimEnd().split("\n");
    expect(lines[0]).toBe("Would scaffold a react front end into api.");
    expect(lines).toContain("Would edit apps/api/wrangler.jsonc.");
    expect(lines.at(-1)).toBe("Dry run. Nothing written.");
    expect(await snapshotTree(dir)).toEqual(before);
  });
});

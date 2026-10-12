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
import { captureStdout, commandAt, expectConforms, runCaptured } from "../test-utils/payloadContract";
import { snapshotTree } from "../test-utils/treeSnapshot";

/**
 * **`pithy worker rename --dry-run` moves nothing and calls nothing that writes (#697).** It does ask the
 * account whether the old script is live — the one read the real rename refuses on — so the recorder
 * answers that read and the test asserts it was the only kind of call made.
 */

const cloudflare = vi.hoisted(() => ({ current: undefined as unknown as { clients: () => Promise<unknown> } }));
vi.mock("../cloudflare/clients", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../cloudflare/clients")>()),
  cloudflareClients: () => cloudflare.current.clients(),
}));

let dir: string;
let account: ReturnType<typeof recorder>;

beforeEach(async () => {
  account = recorder();
  cloudflare.current = account;
  vi.stubEnv("CLOUDFLARE_ACCOUNT_ID", "acct");
  vi.stubEnv("CLOUDFLARE_API_TOKEN", "tok");
  dir = await mkdtemp(join(tmpdir(), "pithy-worker-dry-"));
  await scaffoldProject({ targetDir: dir, appName: "replay", worker: "board" });
  vi.spyOn(process, "cwd").mockReturnValue(dir);
});

afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  await rm(dir, { recursive: true, force: true });
});

describe("pithy worker rename --dry-run", () => {
  test("--json: the published payload with its plan, nothing moved, only reads made", async () => {
    const before = await snapshotTree(dir);
    const written = await runCaptured("worker rename", ["board", "site", "--dry-run", "--json"]);

    await expectConforms("worker rename", written);
    const payload = JSON.parse(written.join(""));
    expect(payload).toMatchObject({ command: "worker.rename", dryRun: true, from: "board", to: "site" });
    expect(payload.accountChecked).toBe(true);
    expect(Plan.parse(payload.plan).files[0]).toEqual({
      path: "apps/site",
      action: "move",
      from: "apps/board",
      changes: [],
    });
    expect(await snapshotTree(dir)).toEqual(before);
    expect(account.calls).toEqual(["workers.listWorkers"]);
    expect(account.writes).toEqual([]);
  });

  test("text: the plan, then the dry-run line in place of Done.", async () => {
    const before = await snapshotTree(dir);
    const written = captureStdout();
    await runCommand(await commandAt("worker rename"), { rawArgs: ["board", "site", "--dry-run"] });
    const lines = written.join("").trimEnd().split("\n");
    expect(lines[0]).toBe("Would move apps/board to apps/site.");
    expect(lines).toContain("Would deploy as replay-site, not replay-board.");
    expect(lines.at(-1)).toBe("Dry run. Nothing written.");
    expect(await snapshotTree(dir)).toEqual(before);
  });
});

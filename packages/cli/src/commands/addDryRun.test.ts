// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { Plan } from "../plan/plan";
import { scaffoldProject } from "../project/scaffold";
import { recorder } from "../test-utils/cloudflareRecorder";
import { linkKitPackages } from "../test-utils/linkKit";
import { captureStdout, expectConforms, runCaptured } from "../test-utils/payloadContract";
import { snapshotTree } from "../test-utils/treeSnapshot";

/**
 * **`pithy add --dry-run` writes nothing and calls nothing that writes (#697)** — the real command, in a
 * scaffolded project, with the Cloudflare clients replaced by one that records every write and the network
 * by one that refuses. The flow itself is `capabilities/planAdd.test.ts`'s; this is the command around it.
 */

const cloudflare = vi.hoisted(() => ({ current: undefined as unknown as { clients: () => Promise<unknown> } }));
vi.mock("../cloudflare/clients", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../cloudflare/clients")>()),
  cloudflareClients: () => cloudflare.current.clients(),
}));

let dir: string;
let account: ReturnType<typeof recorder>;
const fetched: string[] = [];

beforeEach(async () => {
  account = recorder();
  cloudflare.current = account;
  fetched.length = 0;
  vi.spyOn(globalThis, "fetch").mockImplementation(async (url) => {
    fetched.push(String(url));
    throw new Error("A dry run reached the network.");
  });
  // Credentials present, so anything that would reach the account has what it needs to try.
  vi.stubEnv("CLOUDFLARE_ACCOUNT_ID", "acct");
  vi.stubEnv("CLOUDFLARE_API_TOKEN", "tok");
  dir = await mkdtemp(join(tmpdir(), "pithy-add-dry-"));
  await scaffoldProject({ targetDir: dir, appName: "acme", worker: "api" });
  await linkKitPackages(dir, ["core"]);
  const pkg = join(dir, "node_modules", "@pithy-sh", "audit");
  await mkdir(pkg, { recursive: true });
  await writeFile(
    join(pkg, "pithy.manifest.json"),
    JSON.stringify({ name: "audit", package: "@pithy-sh/audit", requiredBindings: [{ type: "d1", name: "DB" }] }),
  );
  await writeFile(join(pkg, "package.json"), JSON.stringify({ name: "@pithy-sh/audit", version: "0.4.0" }));
  vi.spyOn(process, "cwd").mockReturnValue(dir);
});

afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  await rm(dir, { recursive: true, force: true });
});

describe("pithy add --dry-run", () => {
  test("--json: one plan, the published payload, nothing written, nothing that writes called", async () => {
    const before = await snapshotTree(dir);
    const written = await runCaptured("add", ["audit", "--dry-run", "--json"]);

    await expectConforms("add", written);
    const payload = JSON.parse(written.join(""));
    expect(payload).toMatchObject({ command: "add", dryRun: true, capability: "audit", worker: "api" });
    expect(Plan.parse(payload.plan).files.map((file) => file.path)).toEqual([
      "apps/api/package.json",
      "apps/api/pithy.config.ts",
      "apps/api/wrangler.jsonc",
      "package.json",
    ]);
    expect(await snapshotTree(dir)).toEqual(before);
    expect(account.writes).toEqual([]);
    expect(fetched).toEqual([]);
  });

  test("text: the plan, then the dry-run line in place of Done.", async () => {
    const before = await snapshotTree(dir);
    const written = captureStdout();
    const { runCommand } = await import("citty");
    const { default: add } = await import("./add");
    await runCommand(add, { rawArgs: ["audit", "--dry-run"] });
    const lines = written.join("").trimEnd().split("\n");
    expect(lines[0]).toBe("Would wire audit into api.");
    expect(lines).toContain("Would edit apps/api/pithy.config.ts.");
    expect(lines.at(-1)).toBe("Dry run. Nothing written.");
    expect(await snapshotTree(dir)).toEqual(before);
  });
});

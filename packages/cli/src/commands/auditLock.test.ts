// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { runCommand } from "citty";
import { beforeEach, describe, expect, test, vi } from "vitest";
import { EXIT } from "../terminal/exitClass";
import { commandAt, expectConforms, runCaptured } from "../test-utils/payloadContract";

/**
 * `pithy audit lock --env` (#822), with the account stood in for: the bucket it locks, the rule it adds, the
 * refusal before `pithy provision` made the bucket, and the audit row it writes when it changed something.
 */

const r2 = {
  findBucketByName: vi.fn(),
  lockPrefixIndefinitely: vi.fn(),
};
const emitted: unknown[] = [];
const project: { name: string; seed?: { productionEnvironments: string[] } } = { name: "acme" };

vi.mock("../cloudflare/commandCredentials", () => ({
  commandCredentials: () => ({
    account: { accountId: "acct-1", confirmation: null },
    accountId: "acct-1",
    apiToken: "tok-1",
    storeId: "",
    r2Raw: undefined,
  }),
}));
vi.mock("../cloudflare/clients", () => ({ cloudflareClients: async () => ({ r2Provisioner: () => r2 }) }));
vi.mock("../cloudflare/accountAnswer", () => ({
  findOnConfirmedAccount: ({ find }: { find: () => Promise<unknown> }) => find(),
}));
vi.mock("../audit/cliAudit", () => ({
  createProjectCliAudit: async () => async (event: unknown) => void emitted.push(event),
}));
vi.mock("../project/config", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../project/config")>()),
  loadProject: async () => project,
  loadProjectEnvironments: () => ["dev", "staging", "prod", "live"],
  requireProjectName: () => "acme",
  projectCloudflareAccount: async () => null,
}));

beforeEach(() => {
  r2.findBucketByName.mockReset();
  r2.lockPrefixIndefinitely.mockReset();
  emitted.length = 0;
  delete project.seed;
});

/** Run `pithy audit lock` to its refusal, and hand back the one `--json` error line and the exit code. */
async function refusal(rawArgs: string[]): Promise<{ error: Record<string, unknown>; exit: unknown }> {
  const err: string[] = [];
  vi.spyOn(process.stdout, "write").mockImplementation((() => true) as never);
  vi.spyOn(process.stderr, "write").mockImplementation(((chunk: unknown) => err.push(String(chunk)) > 0) as never);
  const exit = vi.spyOn(process, "exit").mockImplementation((() => {
    throw new Error("exited");
  }) as never);
  await runCommand(await commandAt("audit lock"), { rawArgs }).catch(() => undefined);
  const lines = err.join("").trimEnd().split("\n");
  expect(lines).toHaveLength(1);
  return { error: JSON.parse(lines[0] as string).error, exit: exit.mock.calls[0]?.[0] };
}

describe("pithy audit lock", () => {
  test("adds the indefinite rule over the checkpoints, and records it", async () => {
    r2.findBucketByName.mockResolvedValue({ name: "acme-prod-audit-checkpoints" });
    r2.lockPrefixIndefinitely.mockResolvedValue("locked");
    const written = await runCaptured("audit lock", ["--env", "prod", "--json"]);
    await expectConforms("audit lock", written);
    expect(JSON.parse(written.join(""))).toMatchObject({
      env: "prod",
      bucketName: "acme-prod-audit-checkpoints",
      lock: "added",
    });
    expect(r2.lockPrefixIndefinitely).toHaveBeenCalledWith(
      "acme-prod-audit-checkpoints",
      "checkpoints/",
      "pithy-audit-checkpoints",
    );
    expect(emitted).toEqual([
      expect.objectContaining({ action: "audit/checkpoints_locked", resourceId: "acme-prod-audit-checkpoints" }),
    ]);
  });

  test("a lock already in force changes nothing and records nothing", async () => {
    r2.findBucketByName.mockResolvedValue({ name: "acme-staging-audit-checkpoints" });
    r2.lockPrefixIndefinitely.mockResolvedValue("already");
    const written = await runCaptured("audit lock", ["--env", "staging", "--json"]);
    expect(JSON.parse(written.join(""))).toMatchObject({ lock: "already" });
    expect(emitted).toEqual([]);
  });

  test("refuses dev, and a bucket provisioning has not made yet — a precondition, exit 3", async () => {
    await expect(runCaptured("audit lock", ["--env", "dev"])).rejects.toThrow();
    r2.findBucketByName.mockResolvedValue(null);
    await expect(runCaptured("audit lock", ["--env", "prod"])).rejects.toThrow(/exit unexpectedly called with "3"/);
    expect(r2.lockPrefixIndefinitely).not.toHaveBeenCalled();
  });

  test("a missing bucket's refusal carries the provision command as its fix", async () => {
    r2.findBucketByName.mockResolvedValue(null);
    const { error, exit } = await refusal(["--env", "staging", "--json"]);
    expect(exit).toBe(EXIT.precondition);
    expect(error).toMatchObject({
      code: "core/precondition_failed",
      exit: EXIT.precondition,
      fix: "pithy provision --env staging --yes",
    });
  });

  test("an environment the project calls production is a person's to provision, so its refusal carries no fix", async () => {
    project.seed = { productionEnvironments: ["live"] };
    r2.findBucketByName.mockResolvedValue(null);
    const { error, exit } = await refusal(["--env", "live", "--json"]);
    expect(exit).toBe(EXIT.precondition);
    expect(error).toMatchObject({ code: "core/precondition_failed" });
    expect(error).not.toHaveProperty("fix");
    expect(String(error.action)).toContain("a person's decision");
  });
});

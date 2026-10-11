// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { turnstile as turnstileCapability } from "@pithy-sh/turnstile/src/capability";
import type { TurnstileProvisionResult } from "@pithy-sh/turnstile/src/provision/provisionTurnstile";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { expectConforms, runCaptured } from "../test-utils/payloadContract";

/**
 * **What `pithy turnstile` writes under `--json`, held to the schemas `pithy schema turnstile` publishes (#697).**
 *
 * The provisioning itself — widgets, secrets, the config write — is the turnstile package's and its own tests'.
 * It is replaced here by what it returns, typed as it returns it; the command around it is real, down to the
 * production address it reads off the Worker's own `wrangler.jsonc`. Nothing reaches an account.
 */

const SITEKEYS = { sitekeys: { dev: "1x00000000000000000000AA", staging: "1x00000000000000000000AA", prod: "0x4AAA" } };

const fixture = vi.hoisted(() => ({ workerDir: "", projectDir: "", composes: true, deprovisioned: 0 }));

vi.mock("../project/capabilityWorker", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../project/capabilityWorker")>()),
  resolveCapabilityWorker: async () => ({
    worker: { name: "api", dir: fixture.workerDir, capabilities: [] },
    capability: turnstileCapability({ widgets: { visible: SITEKEYS } }),
  }),
}));
vi.mock("../project/workerScope", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../project/workerScope")>()),
  resolveSingleWorker: async () => ({
    name: "acme-api",
    dir: fixture.workerDir,
    capabilities: fixture.composes ? [turnstileCapability({ widgets: { visible: SITEKEYS } })] : [],
  }),
}));
vi.mock("../project/config", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../project/config")>()),
  loadProject: async () => ({ name: "acme", environments: ["staging", "prod", "live"] }),
  projectCloudflareAccount: async () => null,
}));
vi.mock("../cloudflare/config", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../cloudflare/config")>()),
  cloudflareEnv: () => ({ CLOUDFLARE_ACCOUNT_ID: "acct", CLOUDFLARE_API_TOKEN: "token" }),
  cloudflareAccountConfirmation: () => ({ source: "test" }),
}));
vi.mock("../cloudflare/clients", () => ({ cloudflareClients: async () => ({}) }));
vi.mock("../capabilities/secretsDispatcher", () => ({ buildSecretDispatcher: async () => ({}) }));
vi.mock("../audit/cliAudit", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../audit/cliAudit")>()),
  createProjectCliAudit: async () => async () => {},
}));
vi.mock("@pithy-sh/turnstile/src/provision/provisionTurnstile", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@pithy-sh/turnstile/src/provision/provisionTurnstile")>()),
  provisionTurnstile: async (): Promise<TurnstileProvisionResult> => ({
    modes: ["visible"],
    widgets: [{ mode: "visible", sitekey: "0x4AAA", created: true }],
    productionSecretWritten: true,
    sitekeys: { visible: SITEKEYS.sitekeys },
    strandedVarsRemoved: [{ name: "TURNSTILE_SITEKEY_VISIBLE", environment: "staging" }],
  }),
  deprovisionTurnstile: async () => {
    fixture.deprovisioned += 1;
    return { modes: ["visible"] };
  },
}));

beforeEach(async () => {
  fixture.composes = true;
  fixture.deprovisioned = 0;
  fixture.projectDir = await mkdtemp(join(tmpdir(), "pithy-turnstile-json-"));
  fixture.workerDir = join(fixture.projectDir, "apps", "api");
  await mkdir(fixture.workerDir, { recursive: true });
  await writeFile(
    join(fixture.workerDir, "wrangler.jsonc"),
    `${JSON.stringify({ name: "acme-api", env: { prod: { vars: { BASE_URL: "https://app.example.com" } } } })}\n`,
  );
});

afterEach(async () => {
  vi.restoreAllMocks();
  await rm(fixture.projectDir, { recursive: true, force: true });
});

describe("pithy turnstile --json conforms to its published payloads", () => {
  test("provision and deprovision", async () => {
    vi.spyOn(process, "cwd").mockReturnValue(fixture.projectDir);
    await expectConforms("turnstile provision", await runCaptured("turnstile provision", ["--json"]));
    await expectConforms("turnstile deprovision", await runCaptured("turnstile deprovision", ["--json"]));
    expect(fixture.deprovisioned).toBe(1);
  });
});

/**
 * **A Worker that never composed turnstile has nothing to deprovision: exit 0, and nothing removed (#697).**
 * `pithy remove`'s answer to a capability that is not there, not a refusal naming `pithy add`.
 */
describe("pithy turnstile deprovision on a Worker that composes no turnstile", () => {
  test("--json: the document with no modes, and nothing asked of the account", async () => {
    vi.spyOn(process, "cwd").mockReturnValue(fixture.projectDir);
    fixture.composes = false;
    const written = await runCaptured("turnstile deprovision", ["--json"]);
    await expectConforms("turnstile deprovision", written);
    expect(JSON.parse(written.join(""))).toMatchObject({ command: "turnstile deprovision", modes: [] });
    expect(fixture.deprovisioned).toBe(0);
    expect(process.exitCode ?? 0).toBe(0);
  });

  test("text: says so, by the Worker's apps/ directory", async () => {
    vi.spyOn(process, "cwd").mockReturnValue(fixture.projectDir);
    fixture.composes = false;
    const written = await runCaptured("turnstile deprovision", []);
    expect(written.join("")).toBe("api does not compose turnstile. Nothing to deprovision.\n");
    expect(fixture.deprovisioned).toBe(0);
  });
});

// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { chmod, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CloudflareClients } from "@pithy-sh/cloudflare/src/client/clients";
import { parseDevVars } from "@pithy-sh/cloudflare/src/env/devVars";
import { PithyError } from "@pithy-sh/core/src/error/pithyError";
import type { SecretDispatcher, SecretWriteRequest } from "@pithy-sh/secrets/src/cli/dispatch";
import { DEV_SECRETS_FILE } from "@pithy-sh/secrets/src/dev/devSecretsFile";
import { TURNSTILE_SECRET_NAME } from "@pithy-sh/turnstile/src/secret/registry";
import { afterEach, describe, expect, test, vi } from "vitest";
import type { CliAuditEvent } from "../audit/cliAudit";
import { readDevSecrets } from "../devSecrets/file";
import { CloudflareTurnstileDeprovisioner, CloudflareTurnstileProvisioner } from "./turnstileProvisioner";

/** A fake CloudflareClients exposing only the turnstile methods the (de)provisioner touches. */
function fakeCf() {
  const getTurnstile = vi.fn();
  const addTurnstile = vi.fn();
  const deleteTurnstile = vi.fn();
  const listTurnstilesByDomain = vi.fn().mockResolvedValue([]);
  const cf = {
    turnstile: () => ({ getTurnstile, addTurnstile, deleteTurnstile, listTurnstilesByDomain }),
  } as unknown as CloudflareClients;
  return { cf, getTurnstile, addTurnstile, deleteTurnstile, listTurnstilesByDomain };
}

/** The project name every case here provisions under — the leading segment of every widget name. */
const PROJECT = "acme";

/** A dispatcher that records every write request. */
function fakeDispatcher() {
  const calls: SecretWriteRequest[] = [];
  const dispatch = vi.fn(async (request: SecretWriteRequest) => {
    calls.push(request);
  });
  return { dispatcher: { dispatch } satisfies SecretDispatcher, calls, dispatch };
}

const dirs: string[] = [];

/**
 * A project in the per-Worker layout: the root owns the shared `.dev.vars`, and `apps/api/` owns the
 * `wrangler.jsonc` the sitekey vars are written into.
 */
async function project(wrangler = "{}"): Promise<{ projectDir: string; workerDir: string }> {
  const projectDir = await mkdtemp(join(tmpdir(), "pithy-turnstile-"));
  dirs.push(projectDir);
  const workerDir = join(projectDir, "apps", "api");
  await mkdir(workerDir, { recursive: true });
  await writeFile(join(workerDir, "wrangler.jsonc"), wrangler);
  return { projectDir, workerDir };
}

afterEach(() => vi.clearAllMocks());

describe("CloudflareTurnstileProvisioner", () => {
  test("writeDev puts the secret in .dev.secrets.jsonc and the sitekeys in .dev.vars", async () => {
    // `turnstile-secret-keys` is a `d1` registry secret. It was going straight into `.dev.vars`,
    // bypassing `writeDevSecrets` and with it the guarantee that the file is gitignored before a value
    // is written into it — the fifth producer of that same defect (#149). The sitekeys are public,
    // UPPER_SNAKE env vars, and stay where wrangler's namespace belongs.
    const { cf } = fakeCf();
    const { dispatcher } = fakeDispatcher();
    const { projectDir, workerDir } = await project();
    const p = new CloudflareTurnstileProvisioner({ cf, project: PROJECT, projectDir, workerDir, dispatcher });

    await p.writeDev('{"visible":{"key":"1x"}}', { TURNSTILE_SITEKEY_VISIBLE: "1x00" });

    expect(await readDevSecrets(projectDir)).toEqual({
      [TURNSTILE_SECRET_NAME]: { currentVersion: "1", versions: { "1": '{"visible":{"key":"1x"}}' } },
    });
    const content = await readFile(join(projectDir, ".dev.vars"), "utf8");
    expect(content).toContain("TURNSTILE_SITEKEY_VISIBLE=1x00");
    // The transitional injection (#153): dev resolves every secret from its binding, so the envelope
    // goes into `.dev.vars` too — as the envelope, byte for byte what the store holds.
    expect(parseDevVars(content)[TURNSTILE_SECRET_NAME]).toBe(
      '{"currentVersion":"1","versions":{"1":"{\\"visible\\":{\\"key\\":\\"1x\\"}}"}}',
    );
  });

  test("writeDev makes the .gitignore cover the secrets file before it writes the secret", async () => {
    const { cf } = fakeCf();
    const { dispatcher } = fakeDispatcher();
    const { projectDir, workerDir } = await project();
    const p = new CloudflareTurnstileProvisioner({ cf, project: PROJECT, projectDir, workerDir, dispatcher });

    await p.writeDev('{"visible":{"key":"1x"}}', {});

    expect(await readFile(join(projectDir, ".gitignore"), "utf8")).toContain(DEV_SECRETS_FILE);
  });

  test("writeDev refuses outright when the secret cannot be written to an ignored file", async () => {
    // Fail closed. A widget secret written into a committable file is worse than a provision that
    // stopped and said which two lines to add.
    const { cf } = fakeCf();
    const { dispatcher } = fakeDispatcher();
    const { projectDir, workerDir } = await project();
    const p = new CloudflareTurnstileProvisioner({ cf, project: PROJECT, projectDir, workerDir, dispatcher });
    await chmod(projectDir, 0o500);
    try {
      await expect(p.writeDev('{"visible":{"key":"1x"}}', {})).rejects.toThrow(PithyError);
    } finally {
      await chmod(projectDir, 0o700);
    }
  });

  test("a re-provision replaces the value rather than keeping the first widget's secret", async () => {
    const { cf } = fakeCf();
    const { dispatcher } = fakeDispatcher();
    const { projectDir, workerDir } = await project();
    const p = new CloudflareTurnstileProvisioner({ cf, project: PROJECT, projectDir, workerDir, dispatcher });

    await p.writeDev('{"visible":{"key":"first"}}', {});
    await p.writeDev('{"visible":{"key":"second"}}', {});

    expect(await readDevSecrets(projectDir)).toEqual({
      [TURNSTILE_SECRET_NAME]: { currentVersion: "1", versions: { "1": '{"visible":{"key":"second"}}' } },
    });
  });

  test("writeManagedSecret dispatches a create with the d1/environment/json routing facts", async () => {
    const { cf } = fakeCf();
    const { dispatcher, calls } = fakeDispatcher();
    const p = new CloudflareTurnstileProvisioner({ cf, project: PROJECT, ...(await project()), dispatcher });

    await p.writeManagedSecret("staging", '{"visible":{"key":"1x"}}');

    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      env: "staging",
      mode: "create",
      name: TURNSTILE_SECRET_NAME,
      valueType: "json",
      value: '{"visible":{"key":"1x"}}',
    });
  });

  test("writeManagedSecret falls back to update when create fails (idempotent re-run)", async () => {
    const { cf } = fakeCf();
    const dispatch = vi.fn().mockRejectedValueOnce(new Error("already exists")).mockResolvedValueOnce(undefined);
    const p = new CloudflareTurnstileProvisioner({
      cf,
      project: PROJECT,
      ...(await project()),
      dispatcher: { dispatch },
    });

    await p.writeManagedSecret("prod", '{"visible":{"key":"1x"}}');

    expect(dispatch).toHaveBeenCalledTimes(2);
    expect(dispatch.mock.calls[0]?.[0]).toMatchObject({ mode: "create" });
    expect(dispatch.mock.calls[1]?.[0]).toMatchObject({ mode: "update" });
  });

  test("writeManagedSecret surfaces both causes when create AND update fail (no silent swallow)", async () => {
    const { cf } = fakeCf();
    const dispatch = vi
      .fn()
      .mockRejectedValueOnce(new Error("create boom: bad token"))
      .mockRejectedValueOnce(new Error("update boom: not found"));
    const p = new CloudflareTurnstileProvisioner({
      cf,
      project: PROJECT,
      ...(await project()),
      dispatcher: { dispatch },
    });

    await expect(p.writeManagedSecret("prod", '{"visible":{"key":"1x"}}')).rejects.toMatchObject({
      payload: { code: "core/internal", detail: expect.stringContaining("create boom: bad token") },
    });
  });

  test("writeManagedSitekeys writes into the env's wrangler vars, comment-preserving", async () => {
    const { cf } = fakeCf();
    const { dispatcher } = fakeDispatcher();
    const { projectDir, workerDir } = await project('{\n  // staging\n  "env": { "staging": { "vars": {} } }\n}');
    const p = new CloudflareTurnstileProvisioner({ cf, project: PROJECT, projectDir, workerDir, dispatcher });

    await p.writeManagedSitekeys("staging", { TURNSTILE_SITEKEY_VISIBLE: "stg-key" });

    // Written into the WORKER's wrangler.jsonc — there is no root one to write.
    const written = await readFile(join(workerDir, "wrangler.jsonc"), "utf8");
    expect(written).toContain("// staging");
    expect(written).toContain('"TURNSTILE_SITEKEY_VISIBLE": "stg-key"');
  });

  test("ensureProductionWidget creates a managed widget for visible, reuses an existing one", async () => {
    const { cf, getTurnstile, addTurnstile } = fakeCf();
    const { dispatcher } = fakeDispatcher();
    const p = new CloudflareTurnstileProvisioner({ cf, project: PROJECT, ...(await project()), dispatcher });

    getTurnstile.mockResolvedValueOnce(null);
    addTurnstile.mockResolvedValueOnce({ sitekey: "new-key", secret: "new-secret" });
    expect(await p.ensureProductionWidget("visible", "app.example.com")).toEqual({
      sitekey: "new-key",
      secret: "new-secret",
    });
    expect(addTurnstile).toHaveBeenCalledWith("acme-prod-turnstile-visible", ["app.example.com"], "managed");

    getTurnstile.mockResolvedValueOnce({ sitekey: "existing-key" });
    expect(await p.ensureProductionWidget("invisible", "app.example.com")).toEqual({
      sitekey: "existing-key",
      secret: null,
    });
  });

  test("ensureProductionWidget audits a create, and records nothing when it reuses an existing widget", async () => {
    const { cf, getTurnstile, addTurnstile } = fakeCf();
    const { dispatcher } = fakeDispatcher();
    const events: CliAuditEvent[] = [];
    const p = new CloudflareTurnstileProvisioner({
      cf,
      project: PROJECT,
      ...(await project()),
      dispatcher,
      audit: async (event) => void events.push(event),
    });

    getTurnstile.mockResolvedValueOnce(null);
    addTurnstile.mockResolvedValueOnce({ sitekey: "new-key", secret: "new-secret" });
    await p.ensureProductionWidget("visible", "app.example.com");
    expect(events).toEqual([
      expect.objectContaining({
        action: "turnstile/widget_created",
        outcome: "success",
        severity: "info",
        resourceType: "turnstile_widget",
        resourceId: "new-key",
        metadata: { name: "acme-prod-turnstile-visible", mode: "visible", domain: "app.example.com" },
      }),
    ]);
    // Never the widget's secret.
    expect(JSON.stringify(events)).not.toContain("new-secret");

    events.length = 0;
    getTurnstile.mockResolvedValueOnce({ sitekey: "existing-key" });
    await p.ensureProductionWidget("invisible", "app.example.com");
    expect(events).toEqual([]);
  });

  test("two projects in one account provision two distinct widgets, never adopting each other's", async () => {
    const { cf, getTurnstile, addTurnstile } = fakeCf();
    const { dispatcher } = fakeDispatcher();
    const acme = new CloudflareTurnstileProvisioner({ cf, project: "acme", ...(await project()), dispatcher });
    const globex = new CloudflareTurnstileProvisioner({ cf, project: "globex", ...(await project()), dispatcher });

    getTurnstile.mockResolvedValue(null);
    addTurnstile.mockResolvedValue({ sitekey: "k", secret: "s" });
    await acme.ensureProductionWidget("visible", "app.example.com");
    await globex.ensureProductionWidget("visible", "app.globex.com");

    expect(getTurnstile.mock.calls.map((c) => c[0])).toEqual([
      "acme-prod-turnstile-visible",
      "globex-prod-turnstile-visible",
    ]);
  });
});

describe("CloudflareTurnstileProvisioner.assertDomainAvailable", () => {
  test("refuses a domain a foreign widget already claims, naming the domain and the widget", async () => {
    const { cf, listTurnstilesByDomain } = fakeCf();
    const { dispatcher } = fakeDispatcher();
    const p = new CloudflareTurnstileProvisioner({ cf, project: PROJECT, ...(await project()), dispatcher });

    listTurnstilesByDomain.mockResolvedValue([{ name: "someone-elses-widget", sitekey: "k1" }]);

    await expect(p.assertDomainAvailable("app.example.com")).rejects.toMatchObject({
      payload: {
        code: "validation/invalid_input",
        message: expect.stringContaining("app.example.com"),
        action: expect.any(String),
      },
    });
    await expect(p.assertDomainAvailable("app.example.com")).rejects.toMatchObject({
      payload: { message: expect.stringContaining("someone-elses-widget") },
    });
    expect(listTurnstilesByDomain).toHaveBeenCalledWith("app.example.com");
  });

  test("allows a domain nothing claims", async () => {
    const { cf, listTurnstilesByDomain } = fakeCf();
    const { dispatcher } = fakeDispatcher();
    const p = new CloudflareTurnstileProvisioner({ cf, project: PROJECT, ...(await project()), dispatcher });

    listTurnstilesByDomain.mockResolvedValue([]);
    await expect(p.assertDomainAvailable("app.example.com")).resolves.toBeUndefined();
  });

  test("re-provisioning is idempotent: this project's OWN widgets never trip the guard", async () => {
    const { cf, listTurnstilesByDomain } = fakeCf();
    const { dispatcher } = fakeDispatcher();
    const p = new CloudflareTurnstileProvisioner({ cf, project: PROJECT, ...(await project()), dispatcher });

    // The steady state after a first provision: both of this project's modes hold the domain.
    listTurnstilesByDomain.mockResolvedValue([
      { name: "acme-prod-turnstile-visible", sitekey: "k1" },
      { name: "acme-prod-turnstile-invisible", sitekey: "k2" },
    ]);
    await expect(p.assertDomainAvailable("app.example.com")).resolves.toBeUndefined();
  });

  test("a neighbouring project's widget on the same domain IS foreign, and is refused", async () => {
    const { cf, listTurnstilesByDomain } = fakeCf();
    const { dispatcher } = fakeDispatcher();
    const p = new CloudflareTurnstileProvisioner({ cf, project: PROJECT, ...(await project()), dispatcher });

    listTurnstilesByDomain.mockResolvedValue([
      { name: "acme-prod-turnstile-visible", sitekey: "k1" },
      { name: "globex-prod-turnstile-visible", sitekey: "k2" },
    ]);
    await expect(p.assertDomainAvailable("app.example.com")).rejects.toMatchObject({
      payload: { code: "validation/invalid_input", message: expect.stringContaining("globex") },
    });
  });
});

describe("CloudflareTurnstileDeprovisioner", () => {
  test("deleteProductionWidget deletes by sitekey when present, no-op when absent", async () => {
    const { cf, getTurnstile, deleteTurnstile } = fakeCf();
    const { dispatcher } = fakeDispatcher();
    const d = new CloudflareTurnstileDeprovisioner({ cf, project: PROJECT, ...(await project()), dispatcher });

    getTurnstile.mockResolvedValueOnce({ sitekey: "key-1" });
    await d.deleteProductionWidget("visible");
    // Teardown recomputes the project-scoped name, so it can only ever delete this project's widget.
    expect(getTurnstile).toHaveBeenCalledWith("acme-prod-turnstile-visible");
    expect(deleteTurnstile).toHaveBeenCalledWith("key-1");

    getTurnstile.mockResolvedValueOnce(null);
    await d.deleteProductionWidget("invisible");
    expect(deleteTurnstile).toHaveBeenCalledTimes(1);
  });

  test("deleteProductionWidget audits a warning-severity delete, only when a widget was actually deleted", async () => {
    const { cf, getTurnstile } = fakeCf();
    const { dispatcher } = fakeDispatcher();
    const events: CliAuditEvent[] = [];
    const d = new CloudflareTurnstileDeprovisioner({
      cf,
      project: PROJECT,
      ...(await project()),
      dispatcher,
      audit: async (event) => void events.push(event),
    });

    getTurnstile.mockResolvedValueOnce({ sitekey: "key-1" });
    await d.deleteProductionWidget("visible");
    expect(events).toEqual([
      expect.objectContaining({
        action: "turnstile/widget_deleted",
        outcome: "success",
        severity: "warning",
        resourceType: "turnstile_widget",
        resourceId: "key-1",
      }),
    ]);

    events.length = 0;
    getTurnstile.mockResolvedValueOnce(null);
    await d.deleteProductionWidget("invisible");
    expect(events).toEqual([]);
  });

  test("deleteManagedSecret dispatches a delete to staging and production", async () => {
    const { cf } = fakeCf();
    const { dispatcher, calls } = fakeDispatcher();
    const d = new CloudflareTurnstileDeprovisioner({ cf, project: PROJECT, ...(await project()), dispatcher });

    await d.deleteManagedSecret();

    expect(calls.map((c) => ({ env: c.env, mode: c.mode, name: c.name }))).toEqual([
      { env: "staging", mode: "delete", name: TURNSTILE_SECRET_NAME },
      { env: "prod", mode: "delete", name: TURNSTILE_SECRET_NAME },
    ]);
  });

  test("clearDev strips the secret + sitekey keys from .dev.vars", async () => {
    const { cf } = fakeCf();
    const { dispatcher } = fakeDispatcher();
    const { projectDir, workerDir } = await project();
    await writeFile(
      join(projectDir, ".dev.vars"),
      `CLOUDFLARE_ACCOUNT_ID=acct\n${TURNSTILE_SECRET_NAME}={"visible":{"key":"1x"}}\nTURNSTILE_SITEKEY_VISIBLE=1x00\n`,
    );
    const d = new CloudflareTurnstileDeprovisioner({ cf, project: PROJECT, projectDir, workerDir, dispatcher });

    await d.clearDev(["visible"]);

    expect(await readFile(join(projectDir, ".dev.vars"), "utf8")).toBe("CLOUDFLARE_ACCOUNT_ID=acct\n");
  });

  test("clearDev takes the secret out of .dev.secrets.jsonc too", async () => {
    // Otherwise the next `pithy dev` seeds and re-injects a key for a widget that no longer exists, and
    // every place anyone would look says turnstile is configured.
    const { cf } = fakeCf();
    const { dispatcher } = fakeDispatcher();
    const { projectDir, workerDir } = await project();
    const p = new CloudflareTurnstileProvisioner({ cf, project: PROJECT, projectDir, workerDir, dispatcher });
    await p.writeDev('{"visible":{"key":"1x"}}', { TURNSTILE_SITEKEY_VISIBLE: "1x00" });
    const d = new CloudflareTurnstileDeprovisioner({ cf, project: PROJECT, projectDir, workerDir, dispatcher });

    await d.clearDev(["visible"]);

    expect(await readDevSecrets(projectDir)).toEqual({});
    expect(parseDevVars(await readFile(join(projectDir, ".dev.vars"), "utf8"))).toEqual({});
  });
});

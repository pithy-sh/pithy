import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CloudflareClients } from "@pithy-sh/cloudflare/src/client/clients";
import type { SecretDispatcher, SecretWriteRequest } from "@pithy-sh/secrets/src/cli/dispatch";
import { TURNSTILE_SECRET_NAME } from "@pithy-sh/turnstile/src/secret/registry";
import { afterEach, describe, expect, test, vi } from "vitest";
import type { CliAuditEvent } from "../audit/cliAudit";
import { CloudflareTurnstileDeprovisioner, CloudflareTurnstileProvisioner } from "./turnstileProvisioner";

/** A fake CloudflareClients exposing only the turnstile methods the (de)provisioner touches. */
function fakeCf() {
  const getTurnstile = vi.fn();
  const addTurnstile = vi.fn();
  const deleteTurnstile = vi.fn();
  const cf = { turnstile: () => ({ getTurnstile, addTurnstile, deleteTurnstile }) } as unknown as CloudflareClients;
  return { cf, getTurnstile, addTurnstile, deleteTurnstile };
}

/** A dispatcher that records every write request. */
function fakeDispatcher() {
  const calls: SecretWriteRequest[] = [];
  const dispatch = vi.fn(async (request: SecretWriteRequest) => {
    calls.push(request);
  });
  return { dispatcher: { dispatch } satisfies SecretDispatcher, calls, dispatch };
}

const dirs: string[] = [];
async function projectDir(wrangler = "{}") {
  const dir = await mkdtemp(join(tmpdir(), "pithy-turnstile-"));
  dirs.push(dir);
  await writeFile(join(dir, "wrangler.jsonc"), wrangler);
  return dir;
}

afterEach(() => vi.clearAllMocks());

describe("CloudflareTurnstileProvisioner", () => {
  test("writeDev upserts the secret + sitekeys into .dev.vars", async () => {
    const { cf } = fakeCf();
    const { dispatcher } = fakeDispatcher();
    const dir = await projectDir();
    const p = new CloudflareTurnstileProvisioner({ cf, projectDir: dir, dispatcher });

    await p.writeDev('{"visible":{"key":"1x"}}', { TURNSTILE_SITEKEY_VISIBLE: "1x00" });

    const content = await readFile(join(dir, ".dev.vars"), "utf8");
    expect(content).toContain(`${TURNSTILE_SECRET_NAME}={"visible":{"key":"1x"}}`);
    expect(content).toContain("TURNSTILE_SITEKEY_VISIBLE=1x00");
  });

  test("writeManagedSecret dispatches a create with the d1/environment/json routing facts", async () => {
    const { cf } = fakeCf();
    const { dispatcher, calls } = fakeDispatcher();
    const p = new CloudflareTurnstileProvisioner({ cf, projectDir: await projectDir(), dispatcher });

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
    const p = new CloudflareTurnstileProvisioner({ cf, projectDir: await projectDir(), dispatcher: { dispatch } });

    await p.writeManagedSecret("production", '{"visible":{"key":"1x"}}');

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
    const p = new CloudflareTurnstileProvisioner({ cf, projectDir: await projectDir(), dispatcher: { dispatch } });

    await expect(p.writeManagedSecret("production", '{"visible":{"key":"1x"}}')).rejects.toMatchObject({
      payload: { code: "core/internal", detail: expect.stringContaining("create boom: bad token") },
    });
  });

  test("writeManagedSitekeys writes into the env's wrangler vars, comment-preserving", async () => {
    const { cf } = fakeCf();
    const { dispatcher } = fakeDispatcher();
    const dir = await projectDir('{\n  // staging\n  "env": { "staging": { "vars": {} } }\n}');
    const p = new CloudflareTurnstileProvisioner({ cf, projectDir: dir, dispatcher });

    await p.writeManagedSitekeys("staging", { TURNSTILE_SITEKEY_VISIBLE: "stg-key" });

    const written = await readFile(join(dir, "wrangler.jsonc"), "utf8");
    expect(written).toContain("// staging");
    expect(written).toContain('"TURNSTILE_SITEKEY_VISIBLE": "stg-key"');
  });

  test("ensureProductionWidget creates a managed widget for visible, reuses an existing one", async () => {
    const { cf, getTurnstile, addTurnstile } = fakeCf();
    const { dispatcher } = fakeDispatcher();
    const p = new CloudflareTurnstileProvisioner({ cf, projectDir: await projectDir(), dispatcher });

    getTurnstile.mockResolvedValueOnce(null);
    addTurnstile.mockResolvedValueOnce({ sitekey: "new-key", secret: "new-secret" });
    expect(await p.ensureProductionWidget("visible", "app.example.com")).toEqual({
      sitekey: "new-key",
      secret: "new-secret",
    });
    expect(addTurnstile).toHaveBeenCalledWith("pithy-turnstile-visible-production", ["app.example.com"], "managed");

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
      projectDir: await projectDir(),
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
        metadata: { name: "pithy-turnstile-visible-production", mode: "visible", domain: "app.example.com" },
      }),
    ]);
    // Never the widget's secret.
    expect(JSON.stringify(events)).not.toContain("new-secret");

    events.length = 0;
    getTurnstile.mockResolvedValueOnce({ sitekey: "existing-key" });
    await p.ensureProductionWidget("invisible", "app.example.com");
    expect(events).toEqual([]);
  });
});

describe("CloudflareTurnstileDeprovisioner", () => {
  test("deleteProductionWidget deletes by sitekey when present, no-op when absent", async () => {
    const { cf, getTurnstile, deleteTurnstile } = fakeCf();
    const { dispatcher } = fakeDispatcher();
    const d = new CloudflareTurnstileDeprovisioner({ cf, projectDir: await projectDir(), dispatcher });

    getTurnstile.mockResolvedValueOnce({ sitekey: "key-1" });
    await d.deleteProductionWidget("visible");
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
      projectDir: await projectDir(),
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
    const d = new CloudflareTurnstileDeprovisioner({ cf, projectDir: await projectDir(), dispatcher });

    await d.deleteManagedSecret();

    expect(calls.map((c) => ({ env: c.env, mode: c.mode, name: c.name }))).toEqual([
      { env: "staging", mode: "delete", name: TURNSTILE_SECRET_NAME },
      { env: "production", mode: "delete", name: TURNSTILE_SECRET_NAME },
    ]);
  });

  test("clearDev strips the secret + sitekey keys from .dev.vars", async () => {
    const { cf } = fakeCf();
    const { dispatcher } = fakeDispatcher();
    const dir = await projectDir();
    await writeFile(
      join(dir, ".dev.vars"),
      `CLOUDFLARE_ACCOUNT_ID=acct\n${TURNSTILE_SECRET_NAME}={"visible":{"key":"1x"}}\nTURNSTILE_SITEKEY_VISIBLE=1x00\n`,
    );
    const d = new CloudflareTurnstileDeprovisioner({ cf, projectDir: dir, dispatcher });

    await d.clearDev(["visible"]);

    expect(await readFile(join(dir, ".dev.vars"), "utf8")).toBe("CLOUDFLARE_ACCOUNT_ID=acct\n");
  });
});

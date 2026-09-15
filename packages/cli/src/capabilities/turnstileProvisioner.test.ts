// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CloudflareClients } from "@pithy-sh/cloudflare/src/client/clients";
import { ValidationError } from "@pithy-sh/core/src/error/pithyError";
import { DEFAULT_ENVIRONMENTS } from "@pithy-sh/core/src/naming/environment";
import type { SecretDispatcher, SecretWriteRequest } from "@pithy-sh/secrets/src/cli/dispatch";
import { deprovisionTurnstile, provisionTurnstile } from "@pithy-sh/turnstile/src/provision/provisionTurnstile";
import {
  TURNSTILE_SECRET_NAME,
  type TurnstileSecrets,
  turnstileSecretsRegistry,
} from "@pithy-sh/turnstile/src/secret/registry";
import { afterEach, describe, expect, test, vi } from "vitest";
import type { CliAuditEvent } from "../audit/cliAudit";
import { readBootstrapVars, writeBootstrapVars } from "../devSecrets/bootstrapVars";
import { readDevSecrets } from "../devSecrets/file";
import { resolveDevSecretsFile } from "../devSecrets/location";
import { linkKitPackages } from "../test-utils/linkKit";
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

/** The Worker config every fixture composes: the registration `pithy add turnstile` scaffolds. */
const WORKER_CONFIG = `import { turnstile } from "@pithy-sh/turnstile/src/capability";

export default {
  capabilities: [
    turnstile({
      widgets: {
        visible: {
          sitekeys: { dev: "", staging: "", prod: "" },
        },
      },
    }),
  ],
};
`;

/**
 * A project in the per-Worker layout: `apps/api/` owns the `pithy.config.ts` the sitekeys are written into,
 * and the `wrangler.jsonc` an older provisioner stranded sitekey vars in.
 */
let projects = 0;
async function project(wrangler = "{}"): Promise<{ projectDir: string; workerDir: string }> {
  const projectDir = await mkdtemp(join(tmpdir(), "pithy-turnstile-"));
  dirs.push(projectDir);
  // The dev secrets file is keyed on the project's `name` (#156), and a distinct one per call keeps
  // two tests from sharing a file. `vitest.setup.ts` keeps all of them out of the real config dir.
  projects += 1;
  await writeFile(join(projectDir, "pithy.config.ts"), `export default { name: "turnstile-${projects}" };\n`);
  const workerDir = join(projectDir, "apps", "api");
  await mkdir(workerDir, { recursive: true });
  await writeFile(join(workerDir, "wrangler.jsonc"), wrangler);
  await writeFile(join(workerDir, "pithy.config.ts"), WORKER_CONFIG);
  await linkKitPackages(projectDir, ["turnstile"]);
  return { projectDir, workerDir };
}

/** What the dev secrets file holds for this project — outside the checkout, resolved as the CLI does. */
async function devSecrets(projectDir: string) {
  return readDevSecrets(await resolveDevSecretsFile(projectDir));
}

afterEach(() => vi.clearAllMocks());

describe("CloudflareTurnstileProvisioner", () => {
  test("writeDev puts the secret in the dev secrets file, and no sitekey anywhere", async () => {
    // `turnstile-secret-keys` is a `d1` registry secret, so it goes through `writeDevSecrets` (#149). The
    // sitekey is not a dev value at all any more: it is a build input, written into `pithy.config.ts` (#590).
    const { cf } = fakeCf();
    const { dispatcher } = fakeDispatcher();
    const { projectDir, workerDir } = await project();
    const p = new CloudflareTurnstileProvisioner({
      account: { accountId: "acct-1", confirmation: "pinned" },
      cf,
      project: PROJECT,
      projectDir,
      workerDir,
      dispatcher,
      environments: DEFAULT_ENVIRONMENTS,
    });

    await p.writeDev({ visible: { key: "1x" } });

    expect(await devSecrets(projectDir)).toEqual({
      [TURNSTILE_SECRET_NAME]: { currentVersion: "1", versions: { "1": { visible: { key: "1x" } } } },
    });
    expect(await readBootstrapVars(projectDir)).toEqual({});
  });

  test("writeDev leaves nothing about the secret in the checkout, and no .gitignore line either", async () => {
    // This used to write the project's `.gitignore` before placing the value, and fail the whole
    // provision when it could not. The widget secret is at `<config>/<project>/secrets.jsonc` now, so
    // there is nothing in the repository to ignore and nothing for a commit to reach (#156).
    const { cf } = fakeCf();
    const { dispatcher } = fakeDispatcher();
    const { projectDir, workerDir } = await project();
    const p = new CloudflareTurnstileProvisioner({
      account: { accountId: "acct-1", confirmation: "pinned" },
      cf,
      project: PROJECT,
      projectDir,
      workerDir,
      dispatcher,
      environments: DEFAULT_ENVIRONMENTS,
    });

    await p.writeDev({ visible: { key: "1x" } });

    await expect(readFile(join(projectDir, ".gitignore"), "utf8")).rejects.toThrow();
    expect(await devSecrets(projectDir)).toEqual({
      [TURNSTILE_SECRET_NAME]: { currentVersion: "1", versions: { "1": { visible: { key: "1x" } } } },
    });
  });

  test("a re-provision replaces the value rather than keeping the first widget's secret", async () => {
    const { cf } = fakeCf();
    const { dispatcher } = fakeDispatcher();
    const { projectDir, workerDir } = await project();
    const p = new CloudflareTurnstileProvisioner({
      account: { accountId: "acct-1", confirmation: "pinned" },
      cf,
      project: PROJECT,
      projectDir,
      workerDir,
      dispatcher,
      environments: DEFAULT_ENVIRONMENTS,
    });

    await p.writeDev({ visible: { key: "first" } });
    await p.writeDev({ visible: { key: "second" } });

    expect(await devSecrets(projectDir)).toEqual({
      [TURNSTILE_SECRET_NAME]: { currentVersion: "1", versions: { "1": { visible: { key: "second" } } } },
    });
  });

  test("removing a stranded dev sitekey names the Worker whose .dev.vars it could not regenerate", async () => {
    // The delivery report `writeDevVars` returns is said, not dropped (the #153 lesson, third call site).
    const { cf } = fakeCf();
    const { dispatcher } = fakeDispatcher();
    const { projectDir, workerDir } = await project();
    await writeBootstrapVars(projectDir, { TURNSTILE_SITEKEY_VISIBLE: "1x00" });
    await writeFile(join(workerDir, ".dev.vars"), "MINE=1\n");
    const notes: string[] = [];
    const p = new CloudflareTurnstileProvisioner({
      account: { accountId: "acct-1", confirmation: "pinned" },
      cf,
      project: PROJECT,
      projectDir,
      workerDir,
      dispatcher,
      environments: DEFAULT_ENVIRONMENTS,
      notes: (line) => void notes.push(line),
    });

    await p.removeStrandedSitekeyVars();

    expect(notes.join("\n")).toContain(workerDir);
    expect(notes.join("\n")).toMatch(/was not generated by pithy/);
  });

  test("with nothing stranded it says nothing and regenerates nothing", async () => {
    const { cf } = fakeCf();
    const { dispatcher } = fakeDispatcher();
    const { projectDir, workerDir } = await project();
    await writeFile(join(workerDir, ".dev.vars"), "MINE=1\n");
    const notes: string[] = [];
    const p = new CloudflareTurnstileProvisioner({
      account: { accountId: "acct-1", confirmation: "pinned" },
      cf,
      project: PROJECT,
      projectDir,
      workerDir,
      dispatcher,
      environments: DEFAULT_ENVIRONMENTS,
      notes: (line) => void notes.push(line),
    });

    expect(await p.removeStrandedSitekeyVars()).toEqual([]);
    expect(notes).toEqual([]);
  });

  test("removeStrandedSitekeyVars takes every TURNSTILE_SITEKEY_* out of every stanza and dev.json, and nothing else", async () => {
    const { cf } = fakeCf();
    const { dispatcher } = fakeDispatcher();
    const { projectDir, workerDir } = await project(
      [
        "{",
        "  // kept",
        '  "vars": { "ENVIRONMENT": "dev", "TURNSTILE_SITEKEY_VISIBLE": "1x00" },',
        '  "env": {',
        '    "staging": { "vars": { "ENVIRONMENT": "staging", "TURNSTILE_SITEKEY_VISIBLE": "1x00" } },',
        '    "live": { "vars": { "ENVIRONMENT": "live", "TURNSTILE_SITEKEY_INVISIBLE": "1x00" } },',
        '    "prod": { "vars": { "ENVIRONMENT": "prod", "TURNSTILE_SITEKEY_VISIBLE": "0x4AAA" } }',
        "  }",
        "}",
      ].join("\n"),
    );
    await writeBootstrapVars(projectDir, { TURNSTILE_SITEKEY_VISIBLE: "1x00", KEEP: "1" });
    const p = new CloudflareTurnstileProvisioner({
      account: { accountId: "acct-1", confirmation: "pinned" },
      cf,
      project: PROJECT,
      projectDir,
      workerDir,
      dispatcher,
      environments: DEFAULT_ENVIRONMENTS,
      notes: () => {},
    });

    const removed = await p.removeStrandedSitekeyVars();

    expect(removed).toEqual([
      { name: "TURNSTILE_SITEKEY_VISIBLE", environment: "dev" },
      { name: "TURNSTILE_SITEKEY_VISIBLE", environment: "staging" },
      { name: "TURNSTILE_SITEKEY_INVISIBLE", environment: "live" },
      { name: "TURNSTILE_SITEKEY_VISIBLE", environment: "prod" },
    ]);
    const written = await readFile(join(workerDir, "wrangler.jsonc"), "utf8");
    expect(written).not.toContain("TURNSTILE_SITEKEY_");
    expect(written).toContain("// kept");
    expect(written).toContain('"ENVIRONMENT": "live"');
    expect(await readBootstrapVars(projectDir)).toEqual({ KEEP: "1" });
  });

  test("writeManagedSecret dispatches a create with the d1/environment/json routing facts", async () => {
    const { cf } = fakeCf();
    const { dispatcher, calls } = fakeDispatcher();
    const p = new CloudflareTurnstileProvisioner({
      account: { accountId: "acct-1", confirmation: "pinned" },
      cf,
      project: PROJECT,
      ...(await project()),
      dispatcher,
      environments: DEFAULT_ENVIRONMENTS,
    });

    await p.writeManagedSecret("staging", { visible: { key: "1x" } });

    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      env: "staging",
      mode: "create",
      name: TURNSTILE_SECRET_NAME,
      valueType: "json",
      value: '{"visible":{"key":"1x"}}',
    });
  });

  /**
   * The two destinations, each asserted in the shape it actually holds (#535).
   *
   * This writer serialized for both and the two do not take the same thing, so the dev file held a
   * JSON string containing JSON — refused by `TurnstileSecrets` at the root, and reported by
   * `pithy doctor` rather than by the run that wrote it.
   */
  test("the dev secrets file gets the shape the registry declares, with nothing to parse first", async () => {
    const { cf } = fakeCf();
    const { dispatcher } = fakeDispatcher();
    const { projectDir, workerDir } = await project();
    const p = new CloudflareTurnstileProvisioner({
      account: { accountId: "acct-1", confirmation: "pinned" },
      cf,
      project: PROJECT,
      projectDir,
      workerDir,
      dispatcher,
      environments: DEFAULT_ENVIRONMENTS,
    });

    await p.writeDev({ visible: { key: "1x" } });

    const file = await devSecrets(projectDir);
    const envelope = file?.[TURNSTILE_SECRET_NAME] as { versions: Record<string, unknown> };
    const stored = envelope.versions["1"];
    // The check `storedVersion` performs at the next `pithy seed`, against the value as written. A
    // `JSON.parse` here would be the test doing the work the reader will not do.
    expect(typeof stored).not.toBe("string");
    expect(turnstileSecretsRegistry[TURNSTILE_SECRET_NAME]?.schema.safeParse(stored).success).toBe(true);
  });

  test("writeManagedSecret refuses a value the registry refuses, before anything is dispatched", async () => {
    const { cf } = fakeCf();
    const { dispatcher, calls } = fakeDispatcher();
    const p = new CloudflareTurnstileProvisioner({
      account: { accountId: "acct-1", confirmation: "pinned" },
      cf,
      project: PROJECT,
      ...(await project()),
      dispatcher,
      environments: DEFAULT_ENVIRONMENTS,
    });

    // Cast, because the type is what the seam already says and this asserts the runtime guard behind
    // it: the manager Workflow cannot hold the schema — a brand-new secret's registry entry is in no
    // deployed manager yet — so the CLI is the authoritative validator and this writer skipped it.
    const rogue = { visible: { key: "1x" }, bogus: {} } as unknown as TurnstileSecrets;
    await expect(p.writeManagedSecret("prod", rogue)).rejects.toMatchObject({
      payload: { code: "secrets/invalid_value" },
    });
    expect(calls).toHaveLength(0);
  });

  test("writeManagedSecret falls back to update when create fails (idempotent re-run)", async () => {
    const { cf } = fakeCf();
    const dispatch = vi.fn().mockRejectedValueOnce(new Error("already exists")).mockResolvedValueOnce(undefined);
    const p = new CloudflareTurnstileProvisioner({
      account: { accountId: "acct-1", confirmation: "pinned" },
      cf,
      project: PROJECT,
      ...(await project()),
      dispatcher: { dispatch },
      environments: DEFAULT_ENVIRONMENTS,
    });

    await p.writeManagedSecret("prod", { visible: { key: "1x" } });

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
      account: { accountId: "acct-1", confirmation: "pinned" },
      cf,
      project: PROJECT,
      ...(await project()),
      dispatcher: { dispatch },
      environments: DEFAULT_ENVIRONMENTS,
    });

    await expect(p.writeManagedSecret("prod", { visible: { key: "1x" } })).rejects.toMatchObject({
      payload: { code: "core/internal", detail: expect.stringContaining("create boom: bad token") },
    });
  });

  test("writeSitekeys writes the registration the Worker's config composes, and no Worker var", async () => {
    const { cf } = fakeCf();
    const { dispatcher } = fakeDispatcher();
    const { projectDir, workerDir } = await project('{\n  // staging\n  "env": { "staging": { "vars": {} } }\n}');
    const p = new CloudflareTurnstileProvisioner({
      account: { accountId: "acct-1", confirmation: "pinned" },
      cf,
      project: PROJECT,
      projectDir,
      workerDir,
      dispatcher,
      environments: DEFAULT_ENVIRONMENTS,
    });

    await p.writeSitekeys({ visible: { dev: "1x-dev", staging: "1x-stg", prod: "0x-prod" } });

    expect(await readFile(join(workerDir, "pithy.config.ts"), "utf8")).toContain(
      'sitekeys: { dev: "1x-dev", staging: "1x-stg", prod: "0x-prod" }',
    );
    expect(await readFile(join(workerDir, "wrangler.jsonc"), "utf8")).not.toContain("TURNSTILE_SITEKEY");
  });

  test("ensureProductionWidget creates a managed widget for visible, reuses an existing one", async () => {
    const { cf, getTurnstile, addTurnstile } = fakeCf();
    const { dispatcher } = fakeDispatcher();
    const p = new CloudflareTurnstileProvisioner({
      account: { accountId: "acct-1", confirmation: "pinned" },
      cf,
      project: PROJECT,
      ...(await project()),
      dispatcher,
      environments: DEFAULT_ENVIRONMENTS,
    });

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
      account: { accountId: "acct-1", confirmation: "pinned" },
      cf,
      project: PROJECT,
      ...(await project()),
      dispatcher,
      environments: DEFAULT_ENVIRONMENTS,
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
    const acme = new CloudflareTurnstileProvisioner({
      account: { accountId: "acct-1", confirmation: "pinned" },
      cf,
      project: "acme",
      ...(await project()),
      dispatcher,
      environments: DEFAULT_ENVIRONMENTS,
    });
    const globex = new CloudflareTurnstileProvisioner({
      account: { accountId: "acct-1", confirmation: "pinned" },
      cf,
      project: "globex",
      ...(await project()),
      dispatcher,
      environments: DEFAULT_ENVIRONMENTS,
    });

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
    const p = new CloudflareTurnstileProvisioner({
      account: { accountId: "acct-1", confirmation: "pinned" },
      cf,
      project: PROJECT,
      ...(await project()),
      dispatcher,
      environments: DEFAULT_ENVIRONMENTS,
    });

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
    const p = new CloudflareTurnstileProvisioner({
      account: { accountId: "acct-1", confirmation: "pinned" },
      cf,
      project: PROJECT,
      ...(await project()),
      dispatcher,
      environments: DEFAULT_ENVIRONMENTS,
    });

    listTurnstilesByDomain.mockResolvedValue([]);
    await expect(p.assertDomainAvailable("app.example.com")).resolves.toBeUndefined();
  });

  test("re-provisioning is idempotent: this project's OWN widgets never trip the guard", async () => {
    const { cf, listTurnstilesByDomain } = fakeCf();
    const { dispatcher } = fakeDispatcher();
    const p = new CloudflareTurnstileProvisioner({
      account: { accountId: "acct-1", confirmation: "pinned" },
      cf,
      project: PROJECT,
      ...(await project()),
      dispatcher,
      environments: DEFAULT_ENVIRONMENTS,
    });

    // The steady state after a first provision: both of this project's modes hold the domain.
    listTurnstilesByDomain.mockResolvedValue([
      { name: "acme-prod-turnstile-visible", sitekey: "k1" },
      { name: "acme-prod-turnstile-invisible", sitekey: "k2" },
    ]);
    await expect(p.assertDomainAvailable("app.example.com")).resolves.toBeUndefined();
  });

  test("a neighboring project's widget on the same domain IS foreign, and is refused", async () => {
    const { cf, listTurnstilesByDomain } = fakeCf();
    const { dispatcher } = fakeDispatcher();
    const p = new CloudflareTurnstileProvisioner({
      account: { accountId: "acct-1", confirmation: "pinned" },
      cf,
      project: PROJECT,
      ...(await project()),
      dispatcher,
      environments: DEFAULT_ENVIRONMENTS,
    });

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
    const d = new CloudflareTurnstileDeprovisioner({
      account: { accountId: "acct-1", confirmation: "pinned" },
      cf,
      project: PROJECT,
      ...(await project()),
      dispatcher,
      environments: DEFAULT_ENVIRONMENTS,
    });

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
      account: { accountId: "acct-1", confirmation: "pinned" },
      cf,
      project: PROJECT,
      ...(await project()),
      dispatcher,
      environments: DEFAULT_ENVIRONMENTS,
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
    const d = new CloudflareTurnstileDeprovisioner({
      account: { accountId: "acct-1", confirmation: "pinned" },
      cf,
      project: PROJECT,
      ...(await project()),
      dispatcher,
      environments: DEFAULT_ENVIRONMENTS,
    });

    await d.deleteManagedSecret();

    expect(calls.map((c) => ({ env: c.env, mode: c.mode, name: c.name }))).toEqual([
      { env: "staging", mode: "delete", name: TURNSTILE_SECRET_NAME },
      { env: "prod", mode: "delete", name: TURNSTILE_SECRET_NAME },
    ]);
  });

  test("clearProductionSitekeys blanks prod and leaves the test sitekeys", async () => {
    const { cf } = fakeCf();
    const { dispatcher } = fakeDispatcher();
    const { projectDir, workerDir } = await project();
    const options = {
      account: { accountId: "acct-1", confirmation: "pinned" as const },
      cf,
      project: PROJECT,
      projectDir,
      workerDir,
      dispatcher,
      environments: DEFAULT_ENVIRONMENTS,
    };
    await new CloudflareTurnstileProvisioner(options).writeSitekeys({
      visible: { dev: "1x-dev", staging: "1x-stg", prod: "0x-prod" },
    });

    await new CloudflareTurnstileDeprovisioner(options).clearProductionSitekeys(["visible"]);

    expect(await readFile(join(workerDir, "pithy.config.ts"), "utf8")).toContain(
      'sitekeys: { dev: "1x-dev", staging: "1x-stg", prod: "" }',
    );
  });

  test("clearDev takes the secret out of the dev secrets file too", async () => {
    // Otherwise the next `pithy dev` seeds and re-injects a key for a widget that no longer exists, and
    // every place anyone would look says turnstile is configured.
    const { cf } = fakeCf();
    const { dispatcher } = fakeDispatcher();
    const { projectDir, workerDir } = await project();
    const p = new CloudflareTurnstileProvisioner({
      account: { accountId: "acct-1", confirmation: "pinned" },
      cf,
      project: PROJECT,
      projectDir,
      workerDir,
      dispatcher,
      environments: DEFAULT_ENVIRONMENTS,
    });
    await p.writeDev({ visible: { key: "1x" } });
    const d = new CloudflareTurnstileDeprovisioner({
      account: { accountId: "acct-1", confirmation: "pinned" },
      cf,
      project: PROJECT,
      projectDir,
      workerDir,
      dispatcher,
      environments: DEFAULT_ENVIRONMENTS,
    });

    await d.clearDev(["visible"]);

    expect(await devSecrets(projectDir)).toEqual({});
  });
});

/**
 * "The domain is free" and "I asked an account nobody claims" are the same empty listing (#378).
 *
 * This one is the worst of the creative sites: the guard's *passing* is what mints a live production
 * widget, so an unconfirmed account turns a safety check into the thing that authorizes the mistake.
 * The account id below is a literal, and the plant is one word.
 */
describe("CloudflareTurnstileProvisioner.assertDomainAvailable on an unconfirmed account", () => {
  test("refuses rather than reading an empty listing as a free domain", async () => {
    const { cf, listTurnstilesByDomain } = fakeCf();
    const { dispatcher } = fakeDispatcher();
    const stranger = new CloudflareTurnstileProvisioner({
      account: { accountId: "acct-stranger", confirmation: "ambient" },
      cf,
      project: PROJECT,
      ...(await project()),
      dispatcher,
      environments: DEFAULT_ENVIRONMENTS,
    });

    listTurnstilesByDomain.mockResolvedValue([]);

    await expect(stranger.assertDomainAvailable("app.example.com")).rejects.toThrow(
      "Nothing states that Cloudflare account acct-stranger is this project's. Nothing was changed.",
    );
    expect(listTurnstilesByDomain).not.toHaveBeenCalled();
  });

  test("a confirmed account still allows a domain nothing claims", async () => {
    const { cf, listTurnstilesByDomain } = fakeCf();
    const { dispatcher } = fakeDispatcher();
    const ours = new CloudflareTurnstileProvisioner({
      account: { accountId: "acct-ours", confirmation: "recorded" },
      cf,
      project: PROJECT,
      ...(await project()),
      dispatcher,
      environments: DEFAULT_ENVIRONMENTS,
    });

    listTurnstilesByDomain.mockResolvedValue([]);
    await expect(ours.assertDomainAvailable("app.example.com")).resolves.toBeUndefined();
  });
});

/**
 * **A run the sitekey writer will refuse creates nothing and writes nothing** (#590 review).
 *
 * The writer ran last: after the dev secret, the staging secret, a real production widget and the prod
 * secret. Its refusals — a key that is not a string literal, a registration it cannot find — read only the
 * source, and none depends on the sitekey Cloudflare returns. So a refused run had already minted a widget
 * and stored both secrets, while the docs said "Nothing is written", and the rerun it asked for reused the
 * widget and warned about a secret that was in fact stored. Teardown had the same order: the widgets and
 * secrets were deleted before `clearProductionSitekeys` refused, and the stranded vars were never removed.
 *
 * Driven through the real orchestrator and the real provisioners, over a stubbed Cloudflare API and a
 * recording dispatcher, so the order under test is the one a command runs.
 */
describe("a refused sitekey write leaves the account and the files as they were", () => {
  const STRANDED = '{ "env": { "prod": { "vars": { "TURNSTILE_SITEKEY_VISIBLE": "0x4AAAold" } } } }';

  /** A project whose Worker config is `config`, and a real provisioner and deprovisioner over stubs. */
  async function refusedFixture(config: string) {
    const fake = fakeCf();
    fake.getTurnstile.mockResolvedValue(null);
    fake.addTurnstile.mockResolvedValue({ sitekey: "0x4AAAreal", secret: "0x4AAAsecret" });
    const recorder = fakeDispatcher();
    const { projectDir, workerDir } = await project(STRANDED);
    await writeFile(join(workerDir, "pithy.config.ts"), config);
    const options = {
      account: { accountId: "acct-1", confirmation: "pinned" as const },
      cf: fake.cf,
      project: PROJECT,
      projectDir,
      workerDir,
      dispatcher: recorder.dispatcher,
      environments: DEFAULT_ENVIRONMENTS,
    };
    /** Every file this run could touch, as it stands. */
    const files = async () => ({
      config: await readFile(join(workerDir, "pithy.config.ts"), "utf8"),
      wrangler: await readFile(join(workerDir, "wrangler.jsonc"), "utf8"),
      devSecrets: await devSecrets(projectDir),
    });
    return {
      fake,
      recorder,
      files,
      provisioner: new CloudflareTurnstileProvisioner(options),
      deprovisioner: new CloudflareTurnstileDeprovisioner(options),
    };
  }

  const STAGING_EXPRESSION = `import { turnstile } from "@pithy-sh/turnstile/src/capability";

const STAGING = process.env.STAGING_SITEKEY ?? "";

export default {
  capabilities: [
    turnstile({
      widgets: {
        visible: {
          sitekeys: { dev: "", staging: STAGING, prod: "" },
        },
      },
    }),
  ],
};
`;

  const ONE_LINE = `import { turnstile } from "@pithy-sh/turnstile/src/capability";

export default { capabilities: [turnstile({ widgets: { visible: { sitekeys: { dev: "", staging: "", prod: "" } } } })] };
`;

  const PROD_EXPRESSION = `import { turnstile } from "@pithy-sh/turnstile/src/capability";

const PROD = "0x4AAAreal";

export default {
  capabilities: [
    turnstile({
      widgets: {
        visible: {
          sitekeys: { dev: "", staging: "", prod: PROD },
        },
      },
    }),
  ],
};
`;

  for (const [shape, config, refusal] of [
    ["a staging sitekey that is an expression", STAGING_EXPRESSION, /widgets\.visible\.sitekeys\.staging/],
    ["a registration on one line", ONE_LINE, /widgets\.visible\.sitekeys\.dev/],
  ] as const) {
    test(`provision over ${shape} refuses before a widget or a secret exists`, async () => {
      const { fake, recorder, files, provisioner } = await refusedFixture(config);
      const before = await files();

      const error = await provisionTurnstile(provisioner, {
        modes: ["visible"],
        productionDomain: "app.example.com",
      }).catch((thrown: unknown) => thrown);

      expect(error).toBeInstanceOf(ValidationError);
      expect((error as ValidationError).message).toMatch(refusal);
      expect(fake.addTurnstile).not.toHaveBeenCalled();
      expect(recorder.calls).toEqual([]);
      expect(await files()).toEqual(before);
    });
  }

  test("provision over a prod sitekey expression refuses before it creates the widget that expression cannot name", async () => {
    // A sitekey Cloudflare has not issued yet is one no expression in the config can already resolve to.
    const { fake, recorder, files, provisioner } = await refusedFixture(PROD_EXPRESSION.replace("0x4AAAreal", "other"));
    const before = await files();

    await expect(
      provisionTurnstile(provisioner, { modes: ["visible"], productionDomain: "app.example.com" }),
    ).rejects.toThrow(/widgets\.visible\.sitekeys\.prod/);

    expect(fake.addTurnstile).not.toHaveBeenCalled();
    expect(recorder.calls).toEqual([]);
    expect(await files()).toEqual(before);
  });

  test("provision over a prod expression that already names the existing widget goes ahead", async () => {
    // The control: the up-front check must not refuse what the writer would accept. The widget exists, so
    // its sitekey is known before anything is written, and the expression already resolves to it.
    const { fake, provisioner } = await refusedFixture(PROD_EXPRESSION);
    fake.getTurnstile.mockResolvedValue({ sitekey: "0x4AAAreal" });

    const result = await provisionTurnstile(provisioner, {
      modes: ["visible"],
      productionDomain: "app.example.com",
    });

    expect(fake.addTurnstile).not.toHaveBeenCalled();
    expect(result.sitekeys.visible?.prod).toBe("0x4AAAreal");
  });

  test("deprovision over a prod sitekey expression refuses before a widget or a secret is deleted", async () => {
    const { fake, recorder, files, deprovisioner } = await refusedFixture(PROD_EXPRESSION);
    fake.getTurnstile.mockResolvedValue({ sitekey: "0x4AAAreal" });
    const before = await files();

    await expect(deprovisionTurnstile(deprovisioner, ["visible"])).rejects.toThrow(/widgets\.visible\.sitekeys\.prod/);

    expect(fake.deleteTurnstile).not.toHaveBeenCalled();
    expect(recorder.calls).toEqual([]);
    expect(await files()).toEqual(before);
  });
});

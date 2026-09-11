// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { defineCapability } from "@pithy-sh/core/src/capability/capability";
import { NotFoundError, PithyError, ValidationError } from "@pithy-sh/core/src/error/pithyError";
import { DEFAULT_ENVIRONMENTS } from "@pithy-sh/core/src/naming/environment";
import { PAYMENTS_PROVIDER_SECRET, paymentsSecretsRegistry } from "@pithy-sh/payments/src/secret/registry";
import { secrets } from "@pithy-sh/secrets/src/capability";
import type { SecretDispatcher, SecretWriteRequest } from "@pithy-sh/secrets/src/cli/dispatch";
import { MASTER_KEY_BINDING } from "@pithy-sh/secrets/src/env/masterKeyBinding";
import { defineSecretRegistry } from "@pithy-sh/secrets/src/registry";
import { describe, expect, test } from "vitest";
import { z } from "zod";
import type { CliAuditEvent } from "../audit/cliAudit";
import type { WorkerConfig } from "../project/config";
import {
  assertNotTheMasterKey,
  resolveSecretRegistry,
  runSecretsList,
  runSecretWrite,
  secretListRows,
  secretWriteEffect,
  secretWriteReportLine,
} from "./secrets";

class StubDispatcher implements SecretDispatcher {
  readonly calls: SecretWriteRequest[] = [];
  async dispatch(request: SecretWriteRequest): Promise<void> {
    this.calls.push(request);
  }
}

const registry = defineSecretRegistry({
  "auth-signing-key": { backend: "d1", scope: "environment", rotatable: true, valueType: "text" },
  "npm-token": { backend: "cf-secrets-store", scope: "global", rotatable: false, valueType: "text" },
  emailer: {
    backend: "d1",
    scope: "environment",
    rotatable: false,
    valueType: "json",
    schema: z.object({ apiKey: z.string().min(4).describe("API key.") }).describe("Emailer."),
  },
});

describe("runSecretWrite", () => {
  test("validates and dispatches a create to the requested env", async () => {
    const dispatcher = new StubDispatcher();
    const envs = await runSecretWrite(registry, dispatcher, {
      mode: "create",
      name: "auth-signing-key",
      value: "k",
      env: "staging",
      environments: DEFAULT_ENVIRONMENTS,
    });
    expect(envs).toEqual(["staging"]);
    expect(dispatcher.calls[0]).toMatchObject({ env: "staging", mode: "create", name: "auth-signing-key", value: "k" });
  });

  test("routes a global cf-secrets-store secret to production", async () => {
    const dispatcher = new StubDispatcher();
    const envs = await runSecretWrite(registry, dispatcher, {
      mode: "create",
      name: "npm-token",
      value: "t",
      // No environment, because a global secret is not narrowed to one. `--env staging` here is the
      // refusal below, not this.
      env: undefined,
      environments: DEFAULT_ENVIRONMENTS,
    });
    expect(envs).toEqual(["prod"]);
  });

  test("refuses to narrow a global secret to one environment, and dispatches nothing", async () => {
    for (const mode of ["create", "update", "delete"] as const) {
      const dispatcher = new StubDispatcher();
      await expect(
        runSecretWrite(registry, dispatcher, {
          mode,
          name: "npm-token",
          value: "t",
          env: "staging",
          environments: DEFAULT_ENVIRONMENTS,
        }),
      ).rejects.toBeInstanceOf(ValidationError);
      expect(dispatcher.calls, mode).toEqual([]);
    }
  });

  test("rejects an undeclared secret", async () => {
    await expect(
      runSecretWrite(registry, new StubDispatcher(), {
        mode: "create",
        name: "nope",
        value: "v",
        env: "staging",
        environments: DEFAULT_ENVIRONMENTS,
      }),
    ).rejects.toBeInstanceOf(NotFoundError);
  });

  test("requires a value for create", async () => {
    await expect(
      runSecretWrite(registry, new StubDispatcher(), {
        mode: "create",
        name: "auth-signing-key",
        env: "staging",
        environments: DEFAULT_ENVIRONMENTS,
      }),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  test("validates a json value client-side before dispatching", async () => {
    const dispatcher = new StubDispatcher();
    await expect(
      runSecretWrite(registry, dispatcher, {
        mode: "create",
        name: "emailer",
        value: JSON.stringify({ apiKey: "no" }),
        env: "staging",
        environments: DEFAULT_ENVIRONMENTS,
      }),
    ).rejects.toThrow();
    expect(dispatcher.calls).toHaveLength(0);
  });

  test("delete dispatches with no value", async () => {
    const dispatcher = new StubDispatcher();
    await runSecretWrite(registry, dispatcher, {
      mode: "delete",
      name: "auth-signing-key",
      env: "prod",
      environments: DEFAULT_ENVIRONMENTS,
    });
    expect(dispatcher.calls[0]).toMatchObject({ env: "prod", mode: "delete", name: "auth-signing-key" });
    expect(dispatcher.calls[0]?.value).toBeUndefined();
  });

  test("audits a create as secrets/set, recording the name but never the value", async () => {
    const dispatcher = new StubDispatcher();
    const events: CliAuditEvent[] = [];

    await runSecretWrite(
      registry,
      dispatcher,
      {
        mode: "create",
        name: "auth-signing-key",
        value: "top-secret-value",
        env: "staging",
        environments: DEFAULT_ENVIRONMENTS,
      },
      async (event) => void events.push(event),
    );

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      action: "secrets/set",
      outcome: "success",
      severity: "warning",
      resourceType: "secret",
      resourceId: "auth-signing-key",
      metadata: { name: "auth-signing-key", environments: ["staging"] },
    });
    expect(JSON.stringify(events[0])).not.toContain("top-secret-value");
  });

  test("audits an update as secrets/rotated and a delete as secrets/removed", async () => {
    const dispatcher = new StubDispatcher();
    const events: CliAuditEvent[] = [];
    const audit = async (event: CliAuditEvent) => void events.push(event);

    await runSecretWrite(
      registry,
      dispatcher,
      { mode: "update", name: "npm-token", value: "v", env: undefined, environments: DEFAULT_ENVIRONMENTS },
      audit,
    );
    await runSecretWrite(
      registry,
      dispatcher,
      { mode: "delete", name: "npm-token", env: undefined, environments: DEFAULT_ENVIRONMENTS },
      audit,
    );

    expect(events.map((e) => e.action)).toEqual(["secrets/rotated", "secrets/removed"]);
    expect(events.every((e) => e.outcome === "success")).toBe(true);
  });

  test("audits a failed dispatch, recording the name and nothing it reached", async () => {
    const failing: SecretDispatcher = {
      dispatch: async () => {
        throw new Error("workflow unreachable");
      },
    };
    const events: CliAuditEvent[] = [];

    await expect(
      runSecretWrite(
        registry,
        failing,
        { mode: "create", name: "auth-signing-key", value: "v", env: "staging", environments: DEFAULT_ENVIRONMENTS },
        async (event) => void events.push(event),
      ),
    ).rejects.toThrow("workflow unreachable");

    expect(events).toEqual([
      expect.objectContaining({
        action: "secrets/set",
        outcome: "failure",
        // The environments it reached before it failed — none, because the first dispatch is what threw
        // — and the backend it was headed for (#517). Never the value, and nothing derived from one.
        metadata: { name: "auth-signing-key", backend: "d1", environments: [] },
      }),
    ]);
  });

  test("a fan-out that dies part-way audits the environments it wrote, not none of them", async () => {
    // `email-link-signing-key` is the shape that matters: `global` + `d1`, so it fans out. The third
    // environment throws, and the trail has to say the first two now hold the new value.
    const fanOut = defineSecretRegistry({
      "email-link-signing-key": { backend: "d1", scope: "global", rotatable: true, valueType: "text" },
    });
    const written: string[] = [];
    const failing: SecretDispatcher = {
      dispatch: async (request) => {
        if (request.env === "prod") throw new Error("D1_ERROR: storage caused object to be reset");
        written.push(request.env);
      },
    };
    const events: CliAuditEvent[] = [];

    await expect(
      runSecretWrite(
        fanOut,
        failing,
        {
          mode: "update",
          name: "email-link-signing-key",
          value: "v",
          env: undefined,
          environments: ["staging", "canary", "prod"],
        },
        async (event) => void events.push(event),
      ),
    ).rejects.toThrow("storage caused object to be reset");

    // Checked against what the dispatcher actually accepted, not against the run's own bookkeeping.
    expect(written).toEqual(["staging", "canary"]);
    expect(events).toHaveLength(1);
    expect(events[0]?.outcome).toBe("failure");
    expect(events[0]?.metadata).toEqual({ name: "email-link-signing-key", backend: "d1", environments: written });
  });

  test("never dispatches or audits an undeclared secret", async () => {
    const events: CliAuditEvent[] = [];
    await expect(
      runSecretWrite(
        registry,
        new StubDispatcher(),
        { mode: "create", name: "nope", value: "v", env: "staging", environments: DEFAULT_ENVIRONMENTS },
        async (event) => void events.push(event),
      ),
    ).rejects.toBeInstanceOf(NotFoundError);
    expect(events).toEqual([]);
  });
});

/**
 * The payments credential bundle, through the CLI path that actually writes it.
 *
 * `pithy payments provision` writes no credential — nothing can mint an API key — so every rail's block
 * arrives here, through `pithy secrets create payments-provider-credentials`. The registry is the real one
 * the capability ships, so this is the CLI's half of the contract: a rail's block either survives the write
 * intact or is refused before anything leaves the machine.
 */
describe("payments-provider-credentials", () => {
  const LEMON_SQUEEZY = { apiKey: "ls_live_abc", webhookSecret: "whsec_abc", storeId: "42" };

  test("a lemonSqueezy block round-trips through the write, field for field", async () => {
    const dispatcher = new StubDispatcher();

    const envs = await runSecretWrite(paymentsSecretsRegistry, dispatcher, {
      mode: "create",
      name: PAYMENTS_PROVIDER_SECRET,
      value: JSON.stringify({ lemonSqueezy: LEMON_SQUEEZY }),
      env: "prod",
      environments: DEFAULT_ENVIRONMENTS,
    });

    expect(envs).toEqual(["prod"]);
    const dispatched = dispatcher.calls[0];
    expect(dispatched).toMatchObject({ name: PAYMENTS_PROVIDER_SECRET, valueType: "json", env: "prod" });
    expect(JSON.parse(dispatched?.value ?? "null")).toEqual({ lemonSqueezy: LEMON_SQUEEZY });
  });

  test("a rail's block joins the others rather than replacing them", async () => {
    // One secret, four optional rails: adding a rail reshapes no storage and adds no binding. What it must
    // not do is cost an operator the blocks already there.
    const dispatcher = new StubDispatcher();
    const both = { stripe: { secretKey: "sk_test_51Abc", webhookSecret: "whsec_stripe" }, lemonSqueezy: LEMON_SQUEEZY };

    await runSecretWrite(paymentsSecretsRegistry, dispatcher, {
      mode: "update",
      name: PAYMENTS_PROVIDER_SECRET,
      value: JSON.stringify(both),
      env: "prod",
      environments: DEFAULT_ENVIRONMENTS,
    });

    expect(JSON.parse(dispatcher.calls[0]?.value ?? "null")).toEqual(both);
  });

  test("half a Lemon Squeezy credential is refused here, not at the first webhook", async () => {
    // A block is present in full or absent entirely. Half of it dispatched is a signature check that
    // silently never passes, in an environment nobody is watching.
    const dispatcher = new StubDispatcher();

    await expect(
      runSecretWrite(paymentsSecretsRegistry, dispatcher, {
        mode: "create",
        name: PAYMENTS_PROVIDER_SECRET,
        value: JSON.stringify({ lemonSqueezy: { apiKey: LEMON_SQUEEZY.apiKey } }),
        env: "prod",
        environments: DEFAULT_ENVIRONMENTS,
      }),
    ).rejects.toBeInstanceOf(PithyError);
    expect(dispatcher.calls).toEqual([]);
  });
});

describe("resolveSecretRegistry", () => {
  test("finds the secrets capability's registry in a loaded worker config", () => {
    const config: WorkerConfig = { capabilities: [secrets({ registry })] };
    expect(resolveSecretRegistry(config)).toMatchObject(registry);
  });

  test("throws when the worker doesn't enable the secrets capability", () => {
    expect(() => resolveSecretRegistry({ capabilities: [] })).toThrow(NotFoundError);
  });

  /**
   * **The property `pithy secrets` is for, and the one nothing asserted — #501.**
   *
   * A capability's secrets live on *its* capability, not on `secrets({ registry })`. This resolved the
   * secrets capability's own slice, so `pithy secrets create auth-session-secret` — the command `pithy
   * add auth` tells an adopter to run — answered "not declared in the registry", and every externally
   * issued credential in the product had no path to a deployed environment. It surfaced at a first
   * deploy rather than at the add, because the capabilities mint dev values themselves.
   *
   * Asserted over a real capability registry rather than a fixture: the bug was that a *contributed*
   * slice went unread, so a hand-written stand-in would have proved the wrong thing.
   */
  test("carries the secrets every other capability declares, not only the secrets capability's own", () => {
    const payments = defineCapability({
      name: "payments",
      requiredBindings: [],
      secretRegistry: paymentsSecretsRegistry,
    });
    const config: WorkerConfig = { capabilities: [secrets({ registry }), payments] };

    const resolved = resolveSecretRegistry(config);

    expect(resolved).toHaveProperty(PAYMENTS_PROVIDER_SECRET);
    expect(resolved[PAYMENTS_PROVIDER_SECRET]).toEqual(paymentsSecretsRegistry[PAYMENTS_PROVIDER_SECRET]);
    // The union, not a replacement: the secrets capability's own slice and the master key survive it.
    expect(resolved).toMatchObject(registry);
    expect(resolved).toHaveProperty("SECRETS_ENCRYPTION_KEYS");
  });
});

describe("runSecretsList", () => {
  test("audits the registry against the present names and gates promotion", () => {
    const view = runSecretsList(registry, ["auth-signing-key"]);
    expect(view.names).toEqual(["auth-signing-key", "emailer", "npm-token"]);
    expect(view.audit.missing).toEqual(["emailer", "npm-token"]);
    expect(view.promotable).toBe(false);
  });

  test("is promotable when nothing is missing", () => {
    const view = runSecretsList(registry, ["auth-signing-key", "emailer", "npm-token"]);
    expect(view.promotable).toBe(true);
  });
});

describe("keyspaces", () => {
  const withKeyspace = defineSecretRegistry({
    "auth-signing-key": { backend: "d1", scope: "environment", rotatable: true, valueType: "text" },
    CONNECTION_SIGNING_KEY: { backend: "d1", scope: "environment", rotatable: true, valueType: "text", keyed: true },
  });

  test("a write to a keyspace is refused — its members are the app's to write, not the CLI's", async () => {
    const dispatcher = new StubDispatcher();
    await expect(
      runSecretWrite(withKeyspace, dispatcher, {
        mode: "create",
        name: "CONNECTION_SIGNING_KEY",
        value: "k",
        env: "staging",
        environments: DEFAULT_ENVIRONMENTS,
      }),
    ).rejects.toBeInstanceOf(ValidationError);
    expect(dispatcher.calls).toEqual([]);
  });

  test("a keyspace is never missing — there is no single value to provision", () => {
    const view = runSecretsList(withKeyspace, ["auth-signing-key"]);
    expect(view.names).toEqual(["CONNECTION_SIGNING_KEY", "auth-signing-key"]);
    expect(view.audit.missing).toEqual([]);
    expect(view.promotable).toBe(true);
  });

  test("a stored member is attributed to its keyspace, not reported as an orphan", () => {
    const view = runSecretsList(withKeyspace, [
      "auth-signing-key",
      "CONNECTION_SIGNING_KEY/conn_a",
      "CONNECTION_SIGNING_KEY/conn_b",
      "left-behind",
    ]);
    expect(view.audit.orphan).toEqual(["left-behind"]);
  });

  test("a member of an undeclared keyspace is still an orphan", () => {
    const view = runSecretsList(withKeyspace, ["auth-signing-key", "GONE_KEYSPACE/conn_a"]);
    expect(view.audit.orphan).toEqual(["GONE_KEYSPACE/conn_a"]);
  });
});

/**
 * **One owner for the master-key refusal, asked twice** (#517).
 *
 * `runSecretWrite` raises it, which is the guarantee: nothing reaches a store without passing through
 * there. `pithy secrets` asks it again *before* reading a value, because a refusal that arrives after a
 * masked prompt has already taken a production credential is a refusal that cost the operator the thing
 * it was protecting. Two call sites, one function — so the two cannot come to two rules.
 */
describe("assertNotTheMasterKey", () => {
  test.each(["create", "update", "delete"] as const)("%s of the master key is refused", (mode) => {
    expect(() => assertNotTheMasterKey(mode, MASTER_KEY_BINDING)).toThrow(
      /master key every other secret is sealed under/,
    );
  });

  test("every other name passes straight through", () => {
    expect(() => assertNotTheMasterKey("create", "auth-signing-key")).not.toThrow();
  });
});

/**
 * # What a write changed, which is not always where it was dispatched (#517)
 *
 * `secretWriteTargets` answers *where does this write go*, and for a `global` + `cf-secrets-store` secret
 * the answer is one environment — the canonical one, whose manager performs the single account-level
 * write. That is the right dispatch answer and the wrong report: the entry is `<project>-global-<secret>`,
 * flat and account-wide, and **every** environment's stanza binds it. So `pithy secrets update npm-token`
 * printed `written to prod` over a change that replaced the credential staging reads too, and an operator
 * who then went to update staging separately was acting on a report of work already done.
 *
 * One producer for the sentence and the `--json` line, because a report of one act said in two places is
 * a report that eventually says two things.
 */
describe("secretWriteEffect", () => {
  const declared = ["staging", "prod"] as const;

  test("a global store secret changed one entry, and every environment reads it", () => {
    const effect = secretWriteEffect(registry["npm-token"], ["prod"], declared);
    expect(effect).toEqual({ environments: ["staging", "prod"], accountEntry: true });
    expect(secretWriteReportLine("npm-token", "update", effect)).toBe(
      "npm-token written to one account entry, read by staging, prod.",
    );
  });

  /** And the revocation says the same thing, so `rm` cannot understate what it removed either. */
  test("the same is true of a delete", () => {
    expect(
      secretWriteReportLine("npm-token", "delete", secretWriteEffect(registry["npm-token"], ["prod"], declared)),
    ).toBe("npm-token removed from one account entry, read by staging, prod.");
  });

  /**
   * The three cells where the dispatch answer *is* the effect: a per-environment secret has one entry or
   * one row per environment, and a `global` + `d1` secret is a real fan-out that writes each database.
   */
  test("an environment-scoped secret reports exactly where it went", () => {
    const effect = secretWriteEffect(registry["auth-signing-key"], ["staging"], declared);
    expect(effect).toEqual({ environments: ["staging"], accountEntry: false });
    expect(secretWriteReportLine("auth-signing-key", "create", effect)).toBe("auth-signing-key written to staging.");
  });

  test("a global d1 secret reports the fan-out it actually performed", () => {
    const fanned = defineSecretRegistry({
      "email-link-signing-key": { backend: "d1", scope: "global", rotatable: true, valueType: "text" },
    });
    const effect = secretWriteEffect(fanned["email-link-signing-key"], ["staging", "prod"], declared);
    expect(effect).toEqual({ environments: ["staging", "prod"], accountEntry: false });
    expect(secretWriteReportLine("email-link-signing-key", "update", effect)).toBe(
      "email-link-signing-key written to staging, prod.",
    );
  });

  /**
   * A partial fan-out still reports what landed, not the declared set — the widening is a fact about a
   * `global` store entry, and a `d1` split is the one thing the report must never smooth over (#324).
   */
  test("an interrupted d1 fan-out is not widened", () => {
    const fanned = defineSecretRegistry({
      "email-link-signing-key": { backend: "d1", scope: "global", rotatable: true, valueType: "text" },
    });
    expect(secretWriteEffect(fanned["email-link-signing-key"], ["staging"], declared).environments).toEqual([
      "staging",
    ]);
  });

  /** An undeclared name is refused before anything is dispatched, so there is nothing to widen. */
  test("an unknown name reports the targets verbatim", () => {
    expect(secretWriteEffect(undefined, ["prod"], declared)).toEqual({ environments: ["prod"], accountEntry: false });
  });
});

/**
 * **`pithy secrets ls` marks what the configuration cannot reach (#541).**
 *
 * The list read as a checklist, so an operator could not tell *not yet done* from *will never apply* —
 * and three settled questions came back on every run. The mark is the shape chosen over a filter,
 * because it answers *what would I have to do to enable this* as well.
 */
describe("secretListRows", () => {
  const registry = defineSecretRegistry({
    "auth-github-credentials": { backend: "d1", scope: "environment", rotatable: false, valueType: "text" },
    "support-r2-credentials": {
      backend: "d1",
      scope: "environment",
      rotatable: false,
      valueType: "text",
      binding: "SUPPORT_BUCKET",
    },
  });

  test("a reachable secret keeps its declaration axes, exactly as before", () => {
    const [row] = secretListRows(registry, new Map());
    expect(row).toEqual({ name: "auth-github-credentials", description: "d1 · environment", applies: true });
  });

  /**
   * **The axes are replaced, not appended to.** `d1 · environment` describes where a value would be
   * stored, and for a secret this project will never hold a value for there is nothing that would be
   * stored. The mark is the whole answer, so it is the whole column.
   */
  test("an unreachable secret reads as the reason instead of the axes", () => {
    const rows = secretListRows(
      registry,
      new Map([["support-r2-credentials", "SUPPORT_BUCKET declined in pithy.config.ts"]]),
    );
    expect(rows[1]).toEqual({
      name: "support-r2-credentials",
      description: "not applicable — SUPPORT_BUCKET declined in pithy.config.ts",
      applies: false,
      reason: "SUPPORT_BUCKET declined in pithy.config.ts",
    });
  });

  /**
   * `applies` is what `--json` gates on. The description is one rendered sentence, identical on both
   * surfaces so the terminal and the JSON line cannot come to say two different things — and `reason`
   * is beside it so nothing has to parse prose to learn why.
   */
  test("every row carries applies, so a consumer never parses the description", () => {
    const rows = secretListRows(registry, new Map([["support-r2-credentials", "off"]]));
    expect(rows.map((row) => row.applies)).toEqual([true, false]);
    expect(rows.map((row) => row.reason)).toEqual([undefined, "off"]);
  });

  /** Sorted by name, and a keyspace still says so — the one entry an operator must not try to set. */
  test("keeps the sort and the keyspace mark", () => {
    const keyed = defineSecretRegistry({
      "tenant-keys": { backend: "d1", scope: "environment", rotatable: true, valueType: "text", keyed: true },
      "auth-session-secret": { backend: "d1", scope: "environment", rotatable: true, valueType: "text" },
    });
    expect(secretListRows(keyed, new Map()).map((row) => row.name)).toEqual(["auth-session-secret", "tenant-keys"]);
    expect(secretListRows(keyed, new Map())[1]?.description).toBe("d1 · environment · rotatable · keyspace");
  });

  /** A reason for a name the registry does not declare is not a row. Nothing invents a secret. */
  test("never invents a row for a name the registry does not declare", () => {
    const rows = secretListRows(registry, new Map([["auth-apple-credentials", "auth() does not enable it"]]));
    expect(rows.map((row) => row.name)).toEqual(["auth-github-credentials", "support-r2-credentials"]);
  });
});

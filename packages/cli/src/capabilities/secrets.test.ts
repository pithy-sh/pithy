// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { NotFoundError, PithyError, ValidationError } from "@pithy-sh/core/src/error/pithyError";
import { DEFAULT_ENVIRONMENTS } from "@pithy-sh/core/src/naming/environment";
import { PAYMENTS_PROVIDER_SECRET, paymentsSecretsRegistry } from "@pithy-sh/payments/src/secret/registry";
import { secrets } from "@pithy-sh/secrets/src/capability";
import type { SecretDispatcher, SecretWriteRequest } from "@pithy-sh/secrets/src/cli/dispatch";
import { defineSecretRegistry } from "@pithy-sh/secrets/src/registry";
import { describe, expect, test } from "vitest";
import { z } from "zod";
import type { CliAuditEvent } from "../audit/cliAudit";
import type { WorkerConfig } from "../project/config";
import { resolveSecretRegistry, runSecretsList, runSecretWrite } from "./secrets";

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
      env: "staging",
      environments: DEFAULT_ENVIRONMENTS,
    });
    expect(envs).toEqual(["prod"]);
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
      { mode: "update", name: "npm-token", value: "v", env: "staging", environments: DEFAULT_ENVIRONMENTS },
      audit,
    );
    await runSecretWrite(
      registry,
      dispatcher,
      { mode: "delete", name: "npm-token", env: "prod", environments: DEFAULT_ENVIRONMENTS },
      audit,
    );

    expect(events.map((e) => e.action)).toEqual(["secrets/rotated", "secrets/removed"]);
    expect(events.every((e) => e.outcome === "success")).toBe(true);
  });

  test("audits a failed dispatch, still recording only the name", async () => {
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
      expect.objectContaining({ action: "secrets/set", outcome: "failure", metadata: { name: "auth-signing-key" } }),
    ]);
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

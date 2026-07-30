// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { NotFoundError, ValidationError } from "@pithy-sh/core/src/error/pithyError";
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
    });
    expect(envs).toEqual(["production"]);
  });

  test("rejects an undeclared secret", async () => {
    await expect(
      runSecretWrite(registry, new StubDispatcher(), { mode: "create", name: "nope", value: "v", env: "staging" }),
    ).rejects.toBeInstanceOf(NotFoundError);
  });

  test("requires a value for create", async () => {
    await expect(
      runSecretWrite(registry, new StubDispatcher(), { mode: "create", name: "auth-signing-key", env: "staging" }),
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
      }),
    ).rejects.toThrow();
    expect(dispatcher.calls).toHaveLength(0);
  });

  test("delete dispatches with no value", async () => {
    const dispatcher = new StubDispatcher();
    await runSecretWrite(registry, dispatcher, { mode: "delete", name: "auth-signing-key", env: "production" });
    expect(dispatcher.calls[0]).toMatchObject({ env: "production", mode: "delete", name: "auth-signing-key" });
    expect(dispatcher.calls[0]?.value).toBeUndefined();
  });

  test("audits a create as secrets/set, recording the name but never the value", async () => {
    const dispatcher = new StubDispatcher();
    const events: CliAuditEvent[] = [];

    await runSecretWrite(
      registry,
      dispatcher,
      { mode: "create", name: "auth-signing-key", value: "top-secret-value", env: "staging" },
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
      { mode: "update", name: "npm-token", value: "v", env: "staging" },
      audit,
    );
    await runSecretWrite(registry, dispatcher, { mode: "delete", name: "npm-token", env: "production" }, audit);

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
        { mode: "create", name: "auth-signing-key", value: "v", env: "staging" },
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
        { mode: "create", name: "nope", value: "v", env: "staging" },
        async (event) => void events.push(event),
      ),
    ).rejects.toBeInstanceOf(NotFoundError);
    expect(events).toEqual([]);
  });
});

describe("resolveSecretRegistry", () => {
  test("finds the secrets capability's registry in a loaded worker config", () => {
    const config: WorkerConfig = { capabilities: [secrets({ registry })] };
    expect(resolveSecretRegistry(config)).toBe(registry);
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

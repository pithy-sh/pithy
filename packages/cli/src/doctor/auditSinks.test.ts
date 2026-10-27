// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import type { Capability } from "@pithy-sh/core/src/capability/capability";
import { describe, expect, test, vi } from "vitest";
import { type AuditSinksOptions, checkAuditSinks, describeAuditSinks } from "./auditSinks";

const worker = { name: "api", dir: "/p/apps/api" };

const SINKS = {
  siem: {
    profile: "splunk-hec",
    url: "https://splunk.example.com:8088/services/collector/event?token=never-shown",
    secret: "splunk-hec-token",
    detail: false,
  },
  auth: {
    profile: "webhook",
    url: "https://hooks.example.com/audit",
    secret: "hook-token",
    actions: ["auth/"],
    detail: true,
  },
};

function composing(sinks: Record<string, unknown> | undefined): AuditSinksOptions["composeWorker"] {
  return async () => ({
    capabilities:
      sinks === undefined ? [] : [{ name: "audit", requiredBindings: [], auditSinks: sinks } as unknown as Capability],
  });
}

function options(overrides: Partial<AuditSinksOptions> = {}): AuditSinksOptions {
  return {
    project: "acme",
    environments: ["dev", "staging", "prod"],
    workers: [worker],
    account: null,
    remoteSkip: null,
    composeWorker: composing(SINKS),
    secretSet: async () => true,
    ...overrides,
  };
}

describe("checkAuditSinks (#824)", () => {
  test("lists every sink: its profile, its host, its filter, and whether it ships detail", async () => {
    const check = await checkAuditSinks(options());
    expect(check.state).toBe("ok");
    expect(check.sinks).toEqual([
      {
        worker: "api",
        sink: "siem",
        profile: "splunk-hec",
        host: "splunk.example.com:8088",
        actions: [],
        detail: false,
        secret: "splunk-hec-token",
      },
      {
        worker: "api",
        sink: "auth",
        profile: "webhook",
        host: "hooks.example.com",
        actions: ["auth/"],
        detail: true,
        secret: "hook-token",
      },
    ]);
    const lines = describeAuditSinks(check);
    expect(lines[0]).toBe(
      "api: siem — splunk-hec to splunk.example.com:8088; every action; redacted; token splunk-hec-token.",
    );
    expect(lines[1]).toBe(
      "api: auth — webhook to hooks.example.com; actions auth/; ships IP, user-agent and metadata; token hook-token.",
    );
    // The path and query are where a key would be, so they never reach the report.
    expect(lines.join("\n")).not.toContain("never-shown");
  });

  test("says whether each token is set in each deployed environment, and never asks dev", async () => {
    const secretSet = vi.fn(async (name: string, env: string) => !(env === "prod" && name === "hook-token"));
    const check = await checkAuditSinks(options({ secretSet }));
    expect(secretSet.mock.calls.map(([, env]) => env)).not.toContain("dev");
    expect(check.state).toBe("findings");
    expect(check.secrets).toContainEqual({ env: "prod", secret: "hook-token", state: "unset" });
    expect(check.secrets).toContainEqual({ env: "staging", secret: "hook-token", state: "set" });
    expect(describeAuditSinks(check)).toContain(
      "prod: hook-token is not set, so its sinks retry every event until it is dead-lettered. Run pithy secrets create hook-token --env prod.",
    );
  });

  test("a project that ships nothing is not applicable, and asks nothing", async () => {
    const secretSet = vi.fn(async () => true);
    expect(await checkAuditSinks(options({ composeWorker: composing(undefined), secretSet }))).toEqual({
      state: "not-applicable",
      sinks: [],
      secrets: [],
    });
    expect(secretSet).not.toHaveBeenCalled();
  });

  test("a project that ships nothing stays not applicable when one environment's config does not compose", async () => {
    // The environment configs block reports the failed composition; this one has nothing to say about it.
    const secretSet = vi.fn(async () => true);
    const composeWorker: AuditSinksOptions["composeWorker"] = async (_worker, env) => {
      if (env === "prod") throw new Error("Billing is not configured for this environment");
      return { capabilities: [] };
    };
    expect(await checkAuditSinks(options({ composeWorker, secretSet }))).toEqual({
      state: "not-applicable",
      sinks: [],
      secrets: [],
    });
    expect(secretSet).not.toHaveBeenCalled();
  });

  test("offline, every token is skipped rather than reported missing", async () => {
    const check = await checkAuditSinks(options({ remoteSkip: "offline" }));
    expect(check.state).toBe("could-not-check");
    expect(check.secrets.every((answer) => answer.state === "skipped")).toBe(true);
  });

  test("a question the manager could not answer is unreadable, never unset", async () => {
    const check = await checkAuditSinks(
      options({
        secretSet: async () => {
          throw new Error("manager unreachable");
        },
      }),
    );
    expect(check.state).toBe("could-not-check");
    expect(check.secrets.every((answer) => answer.state === "unreadable")).toBe(true);
  });
});

// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { describe, expect, it } from "vitest";
import { z } from "zod";
import { defineCapability } from "../capability/capability";
import { PithyError } from "../error/pithyError";
import { hostWorkflowsFor, resolveWorkflowHost, type WorkflowHostTemplate } from "./host";
import { composeWorkflows } from "./register";

/**
 * Mirrors `packages/email/src/workflows/wrangler.jsonc`. The `<filled-at-provision>` markers are
 * documentation, never matched — the resolver overwrites structurally, which is why a fixture using
 * a different marker resolves identically.
 */
function emailTemplate(): WorkflowHostTemplate {
  return {
    name: "pithy-email",
    main: "./worker.ts",
    compatibility_date: "2025-01-01",
    compatibility_flags: ["nodejs_compat"],
    workers_dev: false,
    d1_databases: [
      { binding: "DB", database_name: "pithy-app", database_id: "<filled>" },
      { binding: "EMAIL_SUPPRESSIONS", database_name: "pithy-email-suppressions", database_id: "<filled>" },
      { binding: "SECRETS", database_name: "pithy-secrets", database_id: "<filled>" },
    ],
    send_email: [{ name: "EMAIL", remote: true }],
    secrets_store_secrets: [
      { binding: "SECRETS_ENCRYPTION_KEYS", store_id: "<filled>", secret_name: "SECRETS_ENCRYPTION_KEYS" },
    ],
    workflows: [
      { binding: "EMAIL_SENDER", name: "pithy-email-send", class_name: "EmailSendWorkflow" },
      { binding: "EMAIL_SCHEDULER", name: "pithy-email-schedule", class_name: "EmailSchedulerWorkflow" },
    ],
    triggers: { crons: ["* * * * *"] },
    vars: { BASE_URL: "<filled>", ENVIRONMENT: "<filled>", MAX_ATTEMPTS: "5" },
  };
}

/** Mirrors `packages/media/src/workflows/wrangler.jsonc` — the binding kinds email's template lacks. */
function mediaTemplate(): WorkflowHostTemplate {
  return {
    name: "pithy-media",
    main: "./worker.ts",
    compatibility_date: "2025-01-01",
    workers_dev: false,
    d1_databases: [
      { binding: "DB", database_name: "pithy-app", database_id: "<filled>" },
      { binding: "SECRETS", database_name: "pithy-secrets", database_id: "<filled>" },
    ],
    kv_namespaces: [{ binding: "MEDIA", id: "<filled>" }],
    r2_buckets: [{ binding: "MEDIA_BUCKET", bucket_name: "<filled>" }],
    ai: { binding: "AI" },
    secrets_store_secrets: [
      { binding: "SECRETS_ENCRYPTION_KEYS", store_id: "<filled>", secret_name: "SECRETS_ENCRYPTION_KEYS" },
    ],
    workflows: [
      { binding: "MEDIA_IMAGE_TO_TEXT", name: "pithy-media-image-to-text", class_name: "MediaImageToTextWorkflow" },
    ],
    vars: { MEDIA_CONFIG: "<filled>", ENVIRONMENT: "<filled>" },
  };
}

describe("resolveWorkflowHost", () => {
  it("names the worker pithy-<capability>-<env>", () => {
    const resolved = resolveWorkflowHost(emailTemplate(), { capability: "email", env: "staging" });
    expect(resolved.name).toBe("pithy-email-staging");
  });

  it("does not mutate the template it was given", () => {
    const template = emailTemplate();
    resolveWorkflowHost(template, { capability: "email", env: "staging", databaseIds: { DB: "db-1" } });
    expect(template.name).toBe("pithy-email");
    expect(template.d1_databases?.[0]?.database_id).toBe("<filled>");
  });

  it("fills database ids by binding name and leaves unlisted bindings alone", () => {
    const resolved = resolveWorkflowHost(emailTemplate(), {
      capability: "email",
      env: "staging",
      databaseIds: { DB: "app-id", SECRETS: "secrets-id" },
    });
    expect(resolved.d1_databases).toEqual([
      { binding: "DB", database_name: "pithy-app", database_id: "app-id" },
      { binding: "EMAIL_SUPPRESSIONS", database_name: "pithy-email-suppressions", database_id: "<filled>" },
      { binding: "SECRETS", database_name: "pithy-secrets", database_id: "secrets-id" },
    ]);
  });

  it("leaves database_name alone unless the caller asks for it", () => {
    // Email deliberately lets `pithy-app`/`pithy-secrets` pass through; secrets' own manager rewrites
    // its name. Making it a blanket rule would break one of the two.
    const untouched = resolveWorkflowHost(emailTemplate(), { capability: "email", env: "staging" });
    expect(untouched.d1_databases?.[0]?.database_name).toBe("pithy-app");

    const rewritten = resolveWorkflowHost(emailTemplate(), {
      capability: "email",
      env: "staging",
      databaseNames: { DB: "pithy-app-staging" },
    });
    expect(rewritten.d1_databases?.[0]?.database_name).toBe("pithy-app-staging");
    expect(rewritten.d1_databases?.[2]?.database_name).toBe("pithy-secrets");
  });

  it("suffixes every workflow name with the environment and never rewrites binding or class_name", () => {
    const resolved = resolveWorkflowHost(emailTemplate(), { capability: "email", env: "production" });
    expect(resolved.workflows).toEqual([
      { binding: "EMAIL_SENDER", name: "pithy-email-send-production", class_name: "EmailSendWorkflow" },
      { binding: "EMAIL_SCHEDULER", name: "pithy-email-schedule-production", class_name: "EmailSchedulerWorkflow" },
    ]);
  });

  it("stamps ENVIRONMENT and merges caller vars over the template's", () => {
    const resolved = resolveWorkflowHost(emailTemplate(), {
      capability: "email",
      env: "staging",
      vars: { BASE_URL: "https://api.example.com", MAX_ATTEMPTS: "9" },
    });
    expect(resolved.vars).toEqual({
      BASE_URL: "https://api.example.com",
      MAX_ATTEMPTS: "9",
      ENVIRONMENT: "staging",
    });
  });

  it("ENVIRONMENT always wins, even if a caller tries to set it to something else", () => {
    const resolved = resolveWorkflowHost(emailTemplate(), {
      capability: "email",
      env: "staging",
      vars: { ENVIRONMENT: "production" },
    });
    expect(resolved.vars?.ENVIRONMENT).toBe("staging");
  });

  it("sets the store id on every secrets entry and env-scopes only the master key", () => {
    const resolved = resolveWorkflowHost(emailTemplate(), {
      capability: "email",
      env: "staging",
      secretsStoreId: "store-1",
      masterKeySecretName: "STAGING_SECRETS_ENCRYPTION_KEYS",
    });
    expect(resolved.secrets_store_secrets).toEqual([
      { binding: "SECRETS_ENCRYPTION_KEYS", store_id: "store-1", secret_name: "STAGING_SECRETS_ENCRYPTION_KEYS" },
    ]);
  });

  it("leaves the secrets block untouched when no store id is supplied", () => {
    const resolved = resolveWorkflowHost(emailTemplate(), { capability: "email", env: "staging" });
    expect(resolved.secrets_store_secrets?.[0]?.store_id).toBe("<filled>");
  });

  it("fills KV ids and R2 bucket names", () => {
    const resolved = resolveWorkflowHost(mediaTemplate(), {
      capability: "media",
      env: "staging",
      kvNamespaceIds: { MEDIA: "kv-1" },
      r2BucketNames: { MEDIA_BUCKET: "pithy-media-staging" },
    });
    expect(resolved.kv_namespaces).toEqual([{ binding: "MEDIA", id: "kv-1" }]);
    expect(resolved.r2_buckets).toEqual([{ binding: "MEDIA_BUCKET", bucket_name: "pithy-media-staging" }]);
  });

  it("drops an omitted KV binding entirely rather than binding a namespace that was never created", () => {
    // Media's template hardcodes the MEDIA namespace; a `recordStore: 'd1'` project must not deploy
    // a binding pointing at nothing.
    const resolved = resolveWorkflowHost(mediaTemplate(), {
      capability: "media",
      env: "staging",
      omitKvBindings: ["MEDIA"],
    });
    expect(resolved.kv_namespaces).toBeUndefined();
  });

  it("applies remote: true only to the bindings the caller names", () => {
    const resolved = resolveWorkflowHost(mediaTemplate(), {
      capability: "media",
      env: "staging",
      remoteBindings: ["AI"],
    });
    expect(resolved.ai).toEqual({ binding: "AI", remote: true });
    expect(resolved.r2_buckets?.[0]).not.toHaveProperty("remote");
  });

  it("leaves an existing remote flag in place when no remote bindings are named", () => {
    const resolved = resolveWorkflowHost(emailTemplate(), { capability: "email", env: "staging" });
    expect(resolved.send_email).toEqual([{ name: "EMAIL", remote: true }]);
  });

  it("keeps unknown template keys, so a template may carry fields this contract does not model", () => {
    const template = { ...emailTemplate(), observability: { enabled: true } } as WorkflowHostTemplate;
    const resolved = resolveWorkflowHost(template, { capability: "email", env: "staging" });
    expect((resolved as unknown as { observability: unknown }).observability).toEqual({ enabled: true });
  });

  it("resolves a template with no bindings at all", () => {
    const resolved = resolveWorkflowHost(
      { name: "pithy-bare", main: "./worker.ts" },
      {
        capability: "bare",
        env: "dev",
      },
    );
    expect(resolved).toEqual({ name: "pithy-bare-dev", main: "./worker.ts", vars: { ENVIRONMENT: "dev" } });
  });
});

describe("hostWorkflowsFor", () => {
  const registry = () =>
    composeWorkflows([
      defineCapability({
        name: "email",
        requiredBindings: [],
        workflows: {
          send: { binding: "EMAIL_SENDER", params: z.object({}).describe("None."), className: "EmailSendWorkflow" },
          schedule: {
            binding: "EMAIL_SCHEDULER",
            params: z.object({}).describe("None."),
            className: "EmailSchedulerWorkflow",
            schedule: "* * * * *",
          },
        },
      }),
      defineCapability({
        name: "media",
        requiredBindings: [],
        workflows: {
          "image-to-text": {
            binding: "MEDIA_IMAGE_TO_TEXT",
            params: z.object({}).describe("None."),
            className: "MediaImageToTextWorkflow",
          },
        },
      }),
    ]);

  it("derives one host's workflows array from its own specs, ignoring other capabilities", () => {
    const { workflows } = hostWorkflowsFor(registry(), "email", "staging");
    expect(workflows).toEqual([
      { binding: "EMAIL_SENDER", name: "pithy-email-send-staging", class_name: "EmailSendWorkflow" },
      { binding: "EMAIL_SCHEDULER", name: "pithy-email-schedule-staging", class_name: "EmailSchedulerWorkflow" },
    ]);
  });

  it("collects crons from the scheduled specs only", () => {
    expect(hostWorkflowsFor(registry(), "email", "staging").crons).toEqual(["* * * * *"]);
    expect(hostWorkflowsFor(registry(), "media", "staging").crons).toEqual([]);
  });

  it("produces names identical to what the resolver suffixes onto a committed template", () => {
    // The two paths must not drift: a generated entry and a template entry resolve to one name.
    const generated = hostWorkflowsFor(registry(), "email", "production").workflows[0]?.name;
    const resolved = resolveWorkflowHost(emailTemplate(), { capability: "email", env: "production" }).workflows?.[0]
      ?.name;
    expect(generated).toBe(resolved);
  });

  it("refuses to host a spec with no className — there would be no class for wrangler to instantiate", () => {
    const registryWithoutClass = composeWorkflows([
      defineCapability({
        name: "email",
        requiredBindings: [],
        workflows: { send: { binding: "EMAIL_SENDER", params: z.object({}).describe("None.") } },
      }),
    ]);
    expect(() => hostWorkflowsFor(registryWithoutClass, "email", "staging")).toThrow(PithyError);
  });
});

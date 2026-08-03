// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { describe, expect, it } from "vitest";
import { z } from "zod";
import { defineCapability } from "../capability/capability";
import { PithyError } from "../error/pithyError";
import { hostWorkflowsFor, resolveWorkflowHost, type WorkflowHostParams, type WorkflowHostTemplate } from "./host";
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

/**
 * The params every resolve needs, so each test states only what it is actually exercising.
 * `workflows` is required whenever the template declares any — the resolver no longer invents
 * names by suffixing the template's — so it is defaulted here rather than repeated fifteen times.
 */
function hostParams(overrides: Partial<WorkflowHostParams> = {}): WorkflowHostParams {
  return {
    project: "acme",
    capability: "email",
    env: "staging",
    workflows: [
      { binding: "EMAIL_SENDER", name: "acme-staging-email-send", class_name: "EmailSendWorkflow" },
      { binding: "EMAIL_SCHEDULER", name: "acme-staging-email-schedule", class_name: "EmailSchedulerWorkflow" },
    ],
    ...overrides,
  };
}

/** Media's equivalent — a different capability, and the binding kinds email's template lacks. */
function mediaParams(overrides: Partial<WorkflowHostParams> = {}): WorkflowHostParams {
  return hostParams({
    capability: "media",
    workflows: [
      {
        binding: "MEDIA_IMAGE_TO_TEXT",
        name: "acme-staging-media-image-to-text",
        class_name: "MediaImageToTextWorkflow",
      },
    ],
    ...overrides,
  });
}

describe("resolveWorkflowHost", () => {
  it("names the worker <project>-<env>-<capability>", () => {
    expect(resolveWorkflowHost(emailTemplate(), hostParams()).name).toBe("acme-staging-email");
  });

  it("gives two projects different Worker names, so one deploy cannot overwrite the other", () => {
    const acme = resolveWorkflowHost(emailTemplate(), hostParams()).name;
    const beta = resolveWorkflowHost(emailTemplate(), hostParams({ project: "beta" })).name;
    expect(acme).not.toBe(beta);
  });

  it("does not mutate the template it was given", () => {
    const template = emailTemplate();
    resolveWorkflowHost(template, hostParams({ databaseIds: { DB: "db-1" } }));
    expect(template.name).toBe("pithy-email");
    expect(template.d1_databases?.[0]?.database_id).toBe("<filled>");
    expect(template.workflows?.[0]?.name).toBe("pithy-email-send");
  });

  it("fills database ids by binding name and leaves unlisted bindings alone", () => {
    const resolved = resolveWorkflowHost(
      emailTemplate(),
      hostParams({ databaseIds: { DB: "app-id", SECRETS: "secrets-id" } }),
    );
    expect(resolved.d1_databases).toEqual([
      { binding: "DB", database_name: "pithy-app", database_id: "app-id" },
      { binding: "EMAIL_SUPPRESSIONS", database_name: "pithy-email-suppressions", database_id: "<filled>" },
      { binding: "SECRETS", database_name: "pithy-secrets", database_id: "secrets-id" },
    ]);
  });

  it("leaves database_name alone unless the caller asks for it", () => {
    // Email deliberately lets the app and secrets databases pass through; each capability's own
    // resolver rewrites the names it owns. Making it a blanket rule would break one of the two.
    const untouched = resolveWorkflowHost(emailTemplate(), hostParams());
    expect(untouched.d1_databases?.[0]?.database_name).toBe("pithy-app");

    const rewritten = resolveWorkflowHost(emailTemplate(), hostParams({ databaseNames: { DB: "acme-staging-app" } }));
    expect(rewritten.d1_databases?.[0]?.database_name).toBe("acme-staging-app");
    expect(rewritten.d1_databases?.[2]?.database_name).toBe("pithy-secrets");
  });

  it("takes the workflows array wholesale from the caller, never rewriting binding or class_name", () => {
    const resolved = resolveWorkflowHost(
      emailTemplate(),
      hostParams({
        env: "production",
        workflows: [
          { binding: "EMAIL_SENDER", name: "acme-production-email-send", class_name: "EmailSendWorkflow" },
          { binding: "EMAIL_SCHEDULER", name: "acme-production-email-schedule", class_name: "EmailSchedulerWorkflow" },
        ],
      }),
    );
    expect(resolved.workflows).toEqual([
      { binding: "EMAIL_SENDER", name: "acme-production-email-send", class_name: "EmailSendWorkflow" },
      { binding: "EMAIL_SCHEDULER", name: "acme-production-email-schedule", class_name: "EmailSchedulerWorkflow" },
    ]);
  });

  it("refuses a template that declares workflows when the caller derived none", () => {
    // The old resolver appended `-<env>` to the template's own name, which cannot produce a
    // project-scoped name — it has no way to recover the job. Silently falling back to the
    // template name would deploy an account-colliding Workflow, so absence is an error.
    const { workflows: _omitted, ...withoutWorkflows } = hostParams();
    expect(() => resolveWorkflowHost(emailTemplate(), withoutWorkflows)).toThrow(PithyError);
    // The action names the fix, so whoever hits this knows what to pass rather than what went wrong.
    expect(() => resolveWorkflowHost(emailTemplate(), withoutWorkflows)).toThrowError(
      expect.objectContaining({
        payload: expect.objectContaining({ action: expect.stringContaining("hostWorkflowsFor") }),
      }),
    );
  });

  it("stamps ENVIRONMENT and PROJECT and merges caller vars over the template's", () => {
    const resolved = resolveWorkflowHost(
      emailTemplate(),
      hostParams({ vars: { BASE_URL: "https://api.example.com", MAX_ATTEMPTS: "9" } }),
    );
    expect(resolved.vars).toEqual({
      BASE_URL: "https://api.example.com",
      MAX_ATTEMPTS: "9",
      ENVIRONMENT: "staging",
      PROJECT: "acme",
    });
  });

  it("ENVIRONMENT always wins, even if a caller tries to set it to something else", () => {
    const resolved = resolveWorkflowHost(emailTemplate(), hostParams({ vars: { ENVIRONMENT: "production" } }));
    expect(resolved.vars?.ENVIRONMENT).toBe("staging");
  });

  it("PROJECT always wins too — a host that names the wrong owner stamps another project's assets", () => {
    const resolved = resolveWorkflowHost(emailTemplate(), hostParams({ vars: { PROJECT: "globex" } }));
    expect(resolved.vars?.PROJECT).toBe("acme");
  });

  it("sets the store id on every secrets entry and env-scopes only the master key", () => {
    const resolved = resolveWorkflowHost(
      emailTemplate(),
      hostParams({ secretsStoreId: "store-1", masterKeySecretName: "acme-staging-secrets-encryption-keys" }),
    );
    expect(resolved.secrets_store_secrets).toEqual([
      {
        binding: "SECRETS_ENCRYPTION_KEYS",
        store_id: "store-1",
        secret_name: "acme-staging-secrets-encryption-keys",
      },
    ]);
  });

  it("leaves the secrets block untouched when no store id is supplied", () => {
    const resolved = resolveWorkflowHost(emailTemplate(), hostParams());
    expect(resolved.secrets_store_secrets?.[0]?.store_id).toBe("<filled>");
  });

  it("fills KV ids and R2 bucket names", () => {
    const resolved = resolveWorkflowHost(
      mediaTemplate(),
      mediaParams({ kvNamespaceIds: { MEDIA: "kv-1" }, r2BucketNames: { MEDIA_BUCKET: "acme-staging-media" } }),
    );
    expect(resolved.kv_namespaces).toEqual([{ binding: "MEDIA", id: "kv-1" }]);
    expect(resolved.r2_buckets).toEqual([{ binding: "MEDIA_BUCKET", bucket_name: "acme-staging-media" }]);
  });

  it("drops an omitted KV binding entirely rather than binding a namespace that was never created", () => {
    // Media's template hardcodes the MEDIA namespace; a `recordStore: 'd1'` project must not deploy
    // a binding pointing at nothing.
    const resolved = resolveWorkflowHost(mediaTemplate(), mediaParams({ omitKvBindings: ["MEDIA"] }));
    expect(resolved.kv_namespaces).toBeUndefined();
  });

  it("applies remote: true only to the bindings the caller names", () => {
    const resolved = resolveWorkflowHost(mediaTemplate(), mediaParams({ remoteBindings: ["AI"] }));
    expect(resolved.ai).toEqual({ binding: "AI", remote: true });
    expect(resolved.r2_buckets?.[0]).not.toHaveProperty("remote");
  });

  it("leaves an existing remote flag in place when no remote bindings are named", () => {
    const resolved = resolveWorkflowHost(emailTemplate(), hostParams());
    expect(resolved.send_email).toEqual([{ name: "EMAIL", remote: true }]);
  });

  it("keeps unknown template keys, so a template may carry fields this contract does not model", () => {
    const template = { ...emailTemplate(), observability: { enabled: true } } as WorkflowHostTemplate;
    const resolved = resolveWorkflowHost(template, hostParams());
    expect((resolved as unknown as { observability: unknown }).observability).toEqual({ enabled: true });
  });

  it("resolves a template with no bindings at all", () => {
    const resolved = resolveWorkflowHost(
      { name: "pithy-bare", main: "./worker.ts" },
      hostParams({ capability: "bare", env: "dev" }),
    );
    expect(resolved).toEqual({
      name: "acme-dev-bare",
      main: "./worker.ts",
      vars: { ENVIRONMENT: "dev", PROJECT: "acme" },
    });
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
    const { workflows } = hostWorkflowsFor(registry(), { project: "acme", capability: "email", env: "staging" });
    expect(workflows).toEqual([
      { binding: "EMAIL_SENDER", name: "acme-staging-email-send", class_name: "EmailSendWorkflow" },
      { binding: "EMAIL_SCHEDULER", name: "acme-staging-email-schedule", class_name: "EmailSchedulerWorkflow" },
    ]);
  });

  it("collects crons from the scheduled specs only", () => {
    expect(hostWorkflowsFor(registry(), { project: "acme", capability: "email", env: "staging" }).crons).toEqual([
      "* * * * *",
    ]);
    expect(hostWorkflowsFor(registry(), { project: "acme", capability: "media", env: "staging" }).crons).toEqual([]);
  });

  it("is the only source of a host's workflow names — the resolver passes them through untouched", () => {
    // The two paths must not drift, and there is now only one: hostWorkflowsFor derives the names
    // and the resolver adopts them verbatim.
    const derived = hostWorkflowsFor(registry(), { project: "acme", capability: "email", env: "production" });
    const resolved = resolveWorkflowHost(emailTemplate(), {
      project: "acme",
      capability: "email",
      env: "production",
      workflows: derived.workflows,
    });
    expect(resolved.workflows).toEqual(derived.workflows);
    expect(derived.workflows[0]?.name).toBe("acme-production-email-send");
  });

  it("refuses to host a spec with no className — there would be no class for wrangler to instantiate", () => {
    const registryWithoutClass = composeWorkflows([
      defineCapability({
        name: "email",
        requiredBindings: [],
        workflows: { send: { binding: "EMAIL_SENDER", params: z.object({}).describe("None.") } },
      }),
    ]);
    expect(() =>
      hostWorkflowsFor(registryWithoutClass, { project: "acme", capability: "email", env: "staging" }),
    ).toThrow(PithyError);
  });
});

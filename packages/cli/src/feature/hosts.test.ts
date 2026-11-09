// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { defineCapability } from "@pithy-sh/core/src/capability/capability";
import { featureResourceName, featureWorkerName } from "@pithy-sh/core/src/naming/feature";
import { environmentScope } from "@pithy-sh/core/src/naming/provisionScope";
import type { WorkflowHostTemplate } from "@pithy-sh/core/src/workflow/host";
import { describe, expect, test } from "vitest";
import { z } from "zod";
import { HOST_WORKERS } from "../capabilities/hostRegistry";
import { featureHostNameLeaks, featureHostScripts, featureOwnedIds, hostedWorkflowEntries } from "./hosts";

/**
 * **What a feature host may be called.** Every account-wide name in a feature host's config is the
 * feature's, or the host does not deploy — `project/deployKit.ts` fails its row on any leak this names.
 */
describe("featureHostNameLeaks", () => {
  const identity = { project: "replay", issue: "643", slug: "feature-address" };
  const own = (config: Partial<WorkflowHostTemplate>): WorkflowHostTemplate =>
    ({
      name: "replay-f643-feature-address--email",
      main: "./worker.ts",
      compatibility_date: "2026-06-01",
      ...config,
    }) as WorkflowHostTemplate;

  test("a host named entirely for the feature leaks nothing", () => {
    expect(
      featureHostNameLeaks(
        own({
          workflows: [{ binding: "SEND", name: "replay-f643-feature-address--email-send", class_name: "X" }],
          secrets_store_secrets: [
            { binding: "K", store_id: "s", secret_name: "replay-f643-feature-address--secrets-encryption-keys" },
          ],
        }),
        identity,
      ),
    ).toEqual([]);
  });

  test("names every name another environment or another feature would share", () => {
    expect(
      featureHostNameLeaks(
        own({
          name: "replay-feature-email",
          workflows: [{ binding: "SEND", name: "replay-feature-email-send", class_name: "X" }],
          r2_buckets: [{ binding: "B", bucket_name: "replay-prod-media" }],
          vectorize: [{ binding: "V", index_name: "replay-f644-feature-address--vector-notes" }],
          secrets_store_secrets: [{ binding: "T", store_id: "s", secret_name: "replay-global-secrets-manager-token" }],
        }),
        identity,
      ),
    ).toEqual([
      "script: replay-feature-email",
      "workflow SEND: replay-feature-email-send",
      "r2 B: replay-prod-media",
      "vectorize V: replay-f644-feature-address--vector-notes",
      "store entry T: replay-global-secrets-manager-token",
    ]);
  });

  test("a sibling issue whose number starts with this one's is not this feature's", () => {
    expect(featureHostNameLeaks(own({ name: "replay-f6430-feature-address--email" }), identity)).toEqual([
      "script: replay-f6430-feature-address--email",
    ]);
  });

  /**
   * **The reviewer's reproduction (finding 5 of the review of 8858558c).** The gate checked only the
   * `<project>-f<issue>-` prefix, so a same-issue sibling's names passed, and it never looked at D1 or KV ids,
   * services or queues at all, so production's passed too. Each is now followed to what owns it.
   */
  test("a same-issue sibling's names, and production's D1, KV, services and queues, are all refused", () => {
    const me = { project: "acme", issue: "643", slug: "feature-address" };
    const config = {
      name: "acme-f643-other-branch--email",
      workflows: [{ binding: "EMAIL_SEND", name: "acme-f643-other-branch--email-send", class_name: "X" }],
      r2_buckets: [{ binding: "B", bucket_name: "acme-f643-feature-address-2--media-bucket-r2" }],
      secrets_store_secrets: [
        { binding: "K", store_id: "s", secret_name: "acme-f643-other-branch--secrets-encryption-keys" },
        { binding: "OLD", store_id: "s", secret_name: "acme-f643-feature-address-secrets-encryption-keys" },
      ],
      d1_databases: [{ binding: "DB", database_name: "acme-prod-db", database_id: "PROD-DB-ID" }],
      kv_namespaces: [{ binding: "MEDIA", id: "PROD-KV-ID" }],
      services: [{ binding: "API", service: "acme-prod-api" }],
      queues: { producers: [{ binding: "Q", queue: "acme-prod-q" }], consumers: [{ queue: "acme-prod-q" }] },
    };
    const owned = { d1: new Map([["FEATURE-DB-ID", "acme-f643-feature-address--db-d1"]]), kv: new Map() };
    expect(featureHostNameLeaks(config, me, owned)).toEqual([
      "script: acme-f643-other-branch--email",
      "workflow EMAIL_SEND: acme-f643-other-branch--email-send",
      "r2 B: acme-f643-feature-address-2--media-bucket-r2",
      "store entry K: acme-f643-other-branch--secrets-encryption-keys",
      "store entry OLD: acme-f643-feature-address-secrets-encryption-keys",
      "d1 DB: id PROD-DB-ID is not one this feature created",
      "kv MEDIA: id PROD-KV-ID is not one this feature created",
      "service API: acme-prod-api",
      "queue Q: acme-prod-q",
      "queue consumer: acme-prod-q",
    ]);
    // The feature's own id passes, under its own name.
    expect(
      featureHostNameLeaks(
        { name: "acme-f643-feature-address--email", d1_databases: [{ binding: "DB", database_id: "FEATURE-DB-ID" }] },
        me,
        owned,
      ),
    ).toEqual([]);
  });

  /**
   * The reviewer's case of the review of 4828e1fc: `c` is the first hex of `login`'s hash, so the fitted-slug
   * ownership check passed `feature/12-c`'s Worker and bucket as `feature/12-login`'s.
   */
  test("a sibling whose whole slug is a hash prefix of this one's is not this feature's", () => {
    const login = { project: "acme", issue: "12", slug: "login" };
    const leaks = featureHostNameLeaks(
      {
        name: featureWorkerName(login, "web"),
        services: [{ binding: "API", service: featureWorkerName({ ...login, slug: "c" }, "api") }],
        r2_buckets: [{ binding: "B", bucket_name: featureResourceName({ ...login, slug: "c" }, "B", "r2") }],
      },
      login,
    );
    expect(leaks).toEqual(["service API: acme-f12-c--api", "r2 B: acme-f12-c--b-r2"]);
  });

  test("a binding kind the gate has never seen is refused until it is classified", () => {
    expect(featureHostNameLeaks({ ...own({}), hyperdrive: [{ binding: "PG", id: "x" }] }, identity)).toEqual([
      "unclassified key hyperdrive",
    ]);
  });
});

describe("featureHostScripts", () => {
  test("names a script for every host the registry knows, each the feature's own and each distinct", () => {
    const scripts = featureHostScripts({ project: "replay", issue: "643", slug: "feature-address" });
    expect(scripts.map((host) => host.capability)).toEqual(HOST_WORKERS.map((spec) => spec.capability));
    expect(new Set(scripts.map((host) => host.script)).size).toBe(scripts.length);
    for (const host of scripts) expect(host.script.startsWith("replay-f643-feature-address--")).toBe(true);
  });

  test("names each owning Worker's own script for every host beside the shared one", () => {
    const scripts = featureHostScripts({ project: "replay", issue: "958", slug: "owners" }, ["two"]);
    expect(scripts.filter((host) => host.capability === "email")).toEqual([
      { capability: "email", script: "replay-f958-owners--email" },
      { capability: "email", owner: "two", script: "replay-f958-owners--two---email" },
    ]);
  });
});

describe("featureHostScripts for a long owner", () => {
  test("skips an owned script too long to compose, which no feature could have deployed", () => {
    const owner = "a-very-long-owning-worker-directory-name";
    const scripts = featureHostScripts({ project: "replay", issue: "958", slug: "owners" }, [owner, "two"]);
    expect(scripts.some((host) => host.owner === owner)).toBe(false);
    expect(scripts.filter((host) => host.owner === "two")).toHaveLength(HOST_WORKERS.length);
  });
});

describe("hostedWorkflowEntries", () => {
  const sender = defineCapability({
    name: "email",
    requiredBindings: [{ type: "workflow", name: "EMAIL_SENDER", job: "send", className: "EmailSendWorkflow" }],
    workflows: {
      send: { binding: "EMAIL_SENDER", params: z.object({}).describe("None."), className: "EmailSendWorkflow" },
    },
  });

  test("binds a Worker sharing the database to the shared host", () => {
    expect(hostedWorkflowEntries([sender], environmentScope("acme", "staging"), { dir: "/p/apps/one" })).toEqual([
      {
        capability: "email",
        binding: "EMAIL_SENDER",
        name: "acme-staging-email-send",
        class_name: "EmailSendWorkflow",
        script_name: "acme-staging-email",
      },
    ]);
  });

  test("binds a Worker that owns a binding the host binds to its own host", () => {
    const scope = environmentScope("acme", "staging");
    expect(hostedWorkflowEntries([sender], scope, { dir: "/p/apps/two", ownBindings: ["DB"] })).toEqual([
      {
        capability: "email",
        owner: "two",
        binding: "EMAIL_SENDER",
        name: "acme-staging-two---email-send",
        class_name: "EmailSendWorkflow",
        script_name: "acme-staging-two---email",
      },
    ]);
  });
});

describe("a feature's own support message index", () => {
  const identity = { project: "acme", issue: "94", slug: "hybrid" };

  test("is created only when support's semantic search is on, at its shape, under the feature's name", async () => {
    const { support } = await import("@pithy-sh/support/src/capability");
    const { featureIndexesFor } = await import("./hosts");
    const { KIT_ROOT } = await import("../test-utils/kitRoot");
    expect(await featureIndexesFor([support({})], KIT_ROOT, identity)).toEqual([]);
    const [index, ...rest] = await featureIndexesFor([support({ search: { semantic: true } })], KIT_ROOT, identity);
    expect(rest).toEqual([]);
    expect(index).toMatchObject({ binding: "SUPPORT_VECTORIZE", dimensions: 1024, metric: "cosine", metadata: [] });
    expect(index?.name).toContain("support-messages");
    expect(index?.name).toContain("94");
  });
});

/**
 * **What an owning Worker's feature host may bind.** Its database is the one the feature created for that Worker,
 * `<project>-f<issue>-<slug>--<owner>---<binding>`, so the ids the gate follows hold it beside the shared ones.
 */
describe("featureOwnedIds for a Worker that owns a binding", () => {
  const identity = { project: "acme", issue: "69", slug: "demo" };
  const db = defineCapability({
    name: "email",
    version: null,
    package: "@pithy-sh/email",
    config: z.object({}).describe("None."),
    requiredBindings: [{ type: "d1", name: "DB" }],
  });
  const ids = new Map([
    [featureResourceName(identity, "DB", "d1"), "SHARED-DB"],
    [featureResourceName(identity, "DB", "d1", "two"), "TWO-DB"],
  ]);
  const provisioners = {
    d1: { find: async (name: string) => (ids.has(name) ? { id: ids.get(name) as string } : undefined) },
    kv: { find: async () => undefined },
  } as never;

  test("holds the owner's own feature database beside the shared one", async () => {
    const owned = await featureOwnedIds(provisioners, identity, [db], [{ worker: "two", ownBindings: ["DB"] }]);
    expect([...owned.d1.keys()].sort()).toEqual(["SHARED-DB", "TWO-DB"]);
  });

  test("so the owner's feature host binding its own database passes the gate", async () => {
    const owned = await featureOwnedIds(provisioners, identity, [db], [{ worker: "two", ownBindings: ["DB"] }]);
    const config = {
      name: "acme-f69-demo--two---email",
      main: "./worker.ts",
      compatibility_date: "2026-06-01",
      d1_databases: [
        { binding: "DB", database_name: featureResourceName(identity, "DB", "d1", "two"), database_id: "TWO-DB" },
      ],
    } as WorkflowHostTemplate;
    expect(featureHostNameLeaks(config, identity, owned)).toEqual([]);
  });
});

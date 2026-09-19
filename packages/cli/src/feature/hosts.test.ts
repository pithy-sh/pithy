// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import type { WorkflowHostTemplate } from "@pithy-sh/core/src/workflow/host";
import { describe, expect, test } from "vitest";
import { HOST_WORKERS } from "../capabilities/hostRegistry";
import { featureHostNameLeaks, featureHostScripts } from "./hosts";

/**
 * **What a feature host may be called (#643).** Every account-wide name in a feature host's config is the
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
});

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
      name: "replay-f643-feature-address-email",
      main: "./worker.ts",
      compatibility_date: "2026-06-01",
      ...config,
    }) as WorkflowHostTemplate;

  test("a host named entirely for the feature leaks nothing", () => {
    expect(
      featureHostNameLeaks(
        own({
          workflows: [{ binding: "SEND", name: "replay-f643-feature-address-email-send", class_name: "X" }],
          secrets_store_secrets: [
            { binding: "K", store_id: "s", secret_name: "replay-f643-feature-address-secrets-encryption-keys" },
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
          vectorize: [{ binding: "V", index_name: "replay-f644-feature-address-vector-notes" }],
          secrets_store_secrets: [{ binding: "T", store_id: "s", secret_name: "replay-global-secrets-manager-token" }],
        }),
        identity,
      ),
    ).toEqual([
      "replay-feature-email",
      "replay-feature-email-send",
      "replay-prod-media",
      "replay-f644-feature-address-vector-notes",
      "replay-global-secrets-manager-token",
    ]);
  });

  test("a sibling issue whose number starts with this one's is not this feature's", () => {
    expect(featureHostNameLeaks(own({ name: "replay-f6430-feature-address-email" }), identity)).toEqual([
      "replay-f6430-feature-address-email",
    ]);
  });
});

describe("featureHostScripts", () => {
  test("names a script for every host the registry knows, each the feature's own and each distinct", () => {
    const scripts = featureHostScripts({ project: "replay", issue: "643", slug: "feature-address" });
    expect(scripts.map((host) => host.capability)).toEqual(HOST_WORKERS.map((spec) => spec.capability));
    expect(new Set(scripts.map((host) => host.script)).size).toBe(scripts.length);
    for (const host of scripts) expect(host.script.startsWith("replay-f643-")).toBe(true);
  });
});

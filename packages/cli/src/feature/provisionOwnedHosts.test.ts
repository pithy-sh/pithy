// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defineCapability } from "@pithy-sh/core/src/capability/capability";
import type { FeatureIdentity } from "@pithy-sh/core/src/naming/feature";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import type { ResourceProvisioners } from "../provision/resources";
import { deprovisionFeature } from "./provision";

/**
 * **A feature's teardown deletes the capability hosts a Worker had to itself**, by the names recomputed from the
 * Workers that own a binding — and the Workflows those scripts host, first, as it does for every kit host.
 */
describe("feature teardown and a Worker's own capability hosts", () => {
  let dir: string;
  const identity: FeatureIdentity = { project: "acme", issue: "69", slug: "demo" };

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "pithy-feature-owned-hosts-"));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  test("deletes an owning Worker's own host and the Workflows it hosts", async () => {
    const owned = new Set(["acme-f69-demo--two---email"]);
    const deletedScripts: string[] = [];
    const deletedWorkflows: string[] = [];
    const empty = { find: async () => null, create: async () => ({ id: "x" }), delete: async () => {} };
    await deprovisionFeature({
      projectDir: dir,
      manifestDir: null,
      identity,
      capabilities: [defineCapability({ name: "app", requiredBindings: [{ type: "d1", name: "DB" }] })],
      env: "feature",
      provisioners: { d1: empty, kv: empty, r2: empty, queue: empty } as unknown as ResourceProvisioners,
      workers: [{ name: "two", dir: join(dir, "apps", "two"), ownBindings: ["DB"] }],
      scripts: {
        exists: async (name) => owned.has(name),
        delete: async (name) => void deletedScripts.push(name),
      },
      workflows: {
        hostedBy: async (scripts) =>
          scripts.has("acme-f69-demo--two---email") ? ["acme-f69-demo--two---email-send"] : [],
        delete: async (name) => void deletedWorkflows.push(name),
      },
    });
    expect(deletedWorkflows).toEqual(["acme-f69-demo--two---email-send"]);
    expect(deletedScripts).toEqual(["acme-f69-demo--two---email"]);
  });
});

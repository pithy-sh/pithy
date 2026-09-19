// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PithyError } from "@pithy-sh/core/src/error/pithyError";
import { maxFeatureSlug } from "@pithy-sh/core/src/naming/feature";
import { MAX_PROJECT_NAME } from "@pithy-sh/core/src/naming/resource";
import { email } from "@pithy-sh/email/src/capability";
import { media } from "@pithy-sh/media/src/capability";
import { secrets } from "@pithy-sh/secrets/src/capability";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import type { ResourceProvisioners } from "../provision/resources";
import { provisionFeature } from "./provision";
import { featureNameShapes } from "./slugBudget";

/**
 * **A branch whose slug cannot fit is refused, with the project's maximum (#643, the review of 4828e1fc).**
 *
 * Feature names were fitted with a hash when they ran long, and a hash is a slug a sibling can have: a long
 * project with long same-issue slugs composed one D1 name for two branches. Nothing is fitted now, so the slug
 * has to fit every name the feature composes, and the refusal comes before anything is created.
 */

const CAPABILITIES = [
  email({ fromAddress: "hello@replay.example", fromName: "Replay", baseUrl: "https://replay.example" }),
  media({ recordStore: "kv" }),
  secrets({ registry: {} }),
];

const WORKERS = [{ app: "api", script: "replay-api" }];

describe("featureNameShapes", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "pithy-slug-budget-"));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  test("reads every family the composed capabilities name, and the tightest sets the maximum", async () => {
    const head = { project: "replay", issue: "643" };
    const shapes = await featureNameShapes({ head, capabilities: CAPABILITIES, workers: WORKERS, projectDir: dir });
    const things = shapes.map((shape) => shape.thing);
    // A resource the email capability declares, the app Worker, a kit host, a Workflow it hosts, and the key.
    expect(things).toContain("email-suppressions-d1");
    expect(things).toContain("api");
    expect(things).toContain("payments");
    expect(things).toContain("media-audio-transcribe");
    expect(things).toContain("secrets-encryption-keys");
    // `replay-f643-` is 12; `--media-audio-transcribe` is 24; a Workflow stops at 64: 28.
    expect(maxFeatureSlug(head, shapes)).toBe(28);
  });

  /** The reviewer's case, as the gate sees it: at the longest project and a six-digit issue, five characters. */
  test("gives the longest project and a six-digit issue a small budget, and a name for it", async () => {
    const head = { project: "p".repeat(MAX_PROJECT_NAME), issue: "123456" };
    const shapes = await featureNameShapes({ head, capabilities: CAPABILITIES, workers: WORKERS, projectDir: dir });
    expect(maxFeatureSlug(head, shapes)).toBe(5);
  });
});

describe("provisionFeature refuses a slug that does not fit, before anything is created", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "pithy-slug-budget-"));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  function run(slug: string, created: string[]) {
    const recording = {
      find: async () => null,
      create: async (name: string) => {
        created.push(name);
        return { id: name };
      },
      delete: async () => {},
    };
    return provisionFeature({
      projectDir: dir,
      capabilities: CAPABILITIES,
      identity: { project: "p".repeat(MAX_PROJECT_NAME), issue: "123456", slug },
      provisioners: { d1: recording, kv: recording, r2: recording } as unknown as ResourceProvisioners,
      administersItself: false,
      resolveWorkers: async () => [],
      migrate: async () => {},
      seed: async () => {},
    });
  }

  /** The reviewer's two slugs, which composed one database between them. */
  test.each(["add-search-import", "add-media-webhook"])("refuses %s, naming the maximum", async (slug) => {
    const created: string[] = [];
    const refusal = await run(slug, created).catch((error: unknown) => error);
    expect(refusal).toBeInstanceOf(PithyError);
    expect((refusal as PithyError).message).toBe(
      `Slug "${slug}" is ${slug.length} characters. Feature slugs in ${"p".repeat(MAX_PROJECT_NAME)} stop at 5 characters at issue 123456.`,
    );
    expect(created).toEqual([]);
  });

  test("a slug at the maximum is not refused by it", async () => {
    const created: string[] = [];
    await run("abcde", created).catch(() => {});
    expect(created.length).toBeGreaterThan(0);
  });
});

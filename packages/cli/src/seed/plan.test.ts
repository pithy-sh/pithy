// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import type { ResolvedSeedSet } from "@pithy-sh/core/src/seed/compose";
import { defineSeed } from "@pithy-sh/core/src/seed/seed";
import { describe, expect, test } from "vitest";
import { buildDryRunPlan } from "./plan";

/** Wrap a set in the resolved shape `composeSeeds` produces, so the plan builder sees real input. */
function resolved(key: string, set: ReturnType<typeof defineSeed>): ResolvedSeedSet {
  return { key, capability: key.split("_")[1] ?? "cap", set };
}

describe("buildDryRunPlan", () => {
  test("counts D1 rows, KV entries, and R2 objects per set, never writing", () => {
    const set = defineSeed({
      name: "demo",
      order: 100,
      environments: ["dev"],
      d1: [{ database: "app", table: "boards", rows: [{ id: 1 }, { id: 2 }] }],
      kv: [{ namespace: "cache", store: "flags", entries: [{ key: { k: "a" }, value: 1 }] }],
      r2: [{ binding: "ASSETS", key: "logo.png", body: "x", contentType: "image/png" }],
    });

    const plan = buildDryRunPlan("dev", [resolved("0100_leaderboard_demo", set)]);
    expect(plan).toEqual({
      command: "seed",
      env: "dev",
      dryRun: true,
      sets: [
        {
          name: "0100_leaderboard_demo",
          d1: [{ database: "app", table: "boards", rows: 2 }],
          kv: [{ namespace: "cache", store: "flags", entries: 1 }],
          r2: [{ binding: "ASSETS", key: "logo.png" }],
          media: [],
        },
      ],
    });
  });

  test("defaults media actions to a first run — once uploads, always re-uploads", () => {
    const set = defineSeed({
      name: "media",
      order: 200,
      environments: ["dev"],
      media: [
        { store: "images", mode: "once", file: "a.png", ref: "a.json" },
        { store: "stream", mode: "always", file: "b.mp4", ref: "b.json" },
      ],
    });

    const plan = buildDryRunPlan("dev", [resolved("0200_media_media", set)]);
    expect(plan.sets[0]?.media).toEqual([
      { store: "images", mode: "once", action: "upload" },
      { store: "stream", mode: "always", action: "reupload" },
    ]);
  });

  test("honors a media resolver that reports an already-recorded UUID as a skip", () => {
    const set = defineSeed({
      name: "media",
      order: 200,
      environments: ["dev"],
      media: [{ store: "images", mode: "once", file: "a.png", ref: "a.json" }],
    });

    const plan = buildDryRunPlan("dev", [resolved("0200_media_media", set)], () => ({
      action: "skip",
      id: "img-123",
    }));
    expect(plan.sets[0]?.media).toEqual([{ store: "images", mode: "once", action: "skip", id: "img-123" }]);
  });

  test("an empty set list yields an empty plan", () => {
    expect(buildDryRunPlan("staging", [])).toEqual({ command: "seed", env: "staging", dryRun: true, sets: [] });
  });
});

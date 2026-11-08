// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { PithyError } from "@pithy-sh/core/src/error/pithyError";
import { describe, expect, test } from "vitest";
import { pointsAtCounterpart, repointRefusal, stanzaPointers } from "./repoint";

describe("stanzaPointers", () => {
  test("reads each kind's identity, and only a real one", () => {
    expect(
      stanzaPointers({
        d1_databases: [
          { binding: "DB", database_name: "acme-staging-db", database_id: "d1-uuid" },
          { binding: "OTHER", database_name: "acme-staging-other", database_id: "<database_id>" },
          { binding: "EMPTY", database_id: "" },
        ],
        kv_namespaces: [{ binding: "CACHE", id: "kv-1" }, { binding: "NONE" }],
        r2_buckets: [{ binding: "ASSETS", bucket_name: "acme-staging-assets" }],
        queues: { producers: [{ binding: "JOBS", queue: "acme-staging-jobs" }] },
      }),
    ).toEqual([
      { kind: "d1", binding: "DB", current: "d1-uuid", currentName: "acme-staging-db" },
      { kind: "kv", binding: "CACHE", current: "kv-1" },
      { kind: "r2", binding: "ASSETS", current: "acme-staging-assets" },
      { kind: "queue", binding: "JOBS", current: "acme-staging-jobs" },
    ]);
  });

  test("reads nothing from a stanza that is not there", () => {
    expect(stanzaPointers(undefined)).toEqual([]);
    expect(stanzaPointers("nope")).toEqual([]);
  });
});

describe("pointsAtCounterpart", () => {
  test("reads a database as moved when it names the counterpart, or holds its id and states no name", () => {
    const pointer = { kind: "d1" as const, binding: "DB", current: "d1-shared" };
    expect(pointsAtCounterpart(pointer, { name: "acme-staging-db", foundId: "d1-shared" })).toBe(true);
    expect(pointsAtCounterpart(pointer, { name: "acme-staging-db", foundId: "d1-other" })).toBe(false);
    expect(pointsAtCounterpart(pointer, { name: "acme-staging-db", foundId: null })).toBe(false);
    expect(
      pointsAtCounterpart({ ...pointer, currentName: "acme-staging-db" }, { name: "acme-staging-db", foundId: null }),
    ).toBe(true);
    // A stated name that is not the counterpart's is not a move, whatever the id.
    expect(
      pointsAtCounterpart(
        { ...pointer, currentName: "acme-staging-old" },
        { name: "acme-staging-db", foundId: "d1-shared" },
      ),
    ).toBe(false);
  });

  test("reads a bucket and a queue by name", () => {
    expect(
      pointsAtCounterpart(
        { kind: "r2", binding: "A", current: "acme-staging-a" },
        { name: "acme-staging-a", foundId: null },
      ),
    ).toBe(true);
    expect(
      pointsAtCounterpart(
        { kind: "queue", binding: "J", current: "acme-staging-j" },
        { name: "acme-staging-w---j", foundId: null },
      ),
    ).toBe(false);
  });
});

describe("repointRefusal", () => {
  test("names the Worker, the binding, both names, and that the current one keeps its data", () => {
    const error = repointRefusal("staging", [
      {
        worker: "my-app-other",
        binding: "DB",
        kind: "d1",
        current: "my-app-staging-db",
        next: "my-app-staging-other---db",
      },
    ]);
    expect(error).toBeInstanceOf(PithyError);
    expect(error.payload.message).toBe(
      "my-app-other's DB points at my-app-staging-db. This run names my-app-staging-other---db. my-app-staging-db keeps its data.",
    );
    expect(error.payload.action).toContain("--repoint");
  });
});

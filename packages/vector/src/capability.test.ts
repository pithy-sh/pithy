// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { describe, expect, it } from "vitest";
import { z } from "zod";
import { isVectorCapability, VECTOR_MIGRATION_ORDER, vector } from "./capability";
import { VECTOR_DOCUMENTS_TABLE } from "./data/tables";
import { VECTOR_INDEXES_READ_SCOPE } from "./http/scopes";
import { filterable } from "./index/filter";

const DocMeta = z.object({
  tenantId: filterable(z.string().describe("Tenant.")),
  title: z.string().describe("Title."),
});

const options = { indexes: { docs: { model: "@cf/baai/bge-base-en-v1.5", dimensions: 768, metadata: DocMeta } } };

describe("vector()", () => {
  it("mounts one control-plane read, a GET, advertised on the manifest at the configured mount point (#730)", () => {
    expect(vector(options).adminRoutes).toEqual([
      expect.objectContaining({ method: "GET", path: "/vector/indexes", scope: VECTOR_INDEXES_READ_SCOPE }),
    ]);
    expect(vector({ ...options, basePath: "/search" }).adminRoutes?.map((route) => route.path)).toEqual([
      "/search/indexes",
    ]);
  });

  it("reports two health counts behind the index read's scope, and adds nothing to the runtime token (#730)", () => {
    const capability = vector(options);
    expect(capability.health?.keys.map((key) => [key.key, key.scope])).toEqual([
      ["staleVectorDocuments", VECTOR_INDEXES_READ_SCOPE],
      ["unprovisionedVectorIndexes", VECTOR_INDEXES_READ_SCOPE],
    ]);
    // The read is the binding, the corpus and a var. No Cloudflare API call, so no permission on `runtime`.
    expect(capability.runtimePermissions).toBeUndefined();
  });

  it("exposes its name and resolved config", () => {
    const capability = vector(options);
    expect(capability.name).toBe("vector");
    expect(capability.vectorConfig.indexes.docs?.metric).toBe("cosine");
    expect(isVectorCapability(capability)).toBe(true);
  });

  it("declares the bindings a search needs, marking the two with no local emulation remote", () => {
    expect(vector(options).requiredBindings).toEqual([
      { type: "vectorize", name: "VECTORIZE", optional: false, remote: true },
      { type: "ai", name: "AI", optional: false, remote: true },
      { type: "d1", name: "DB", optional: false },
      // Optional: the vector worker exists only after `pithy vector provision`, and an unprovisioned
      // project must still boot and serve every search route.
      // `job` and `className` ride through from the spec: without them the CLI has no deployed name and
      // no `class_name`, so it declines the `workflows` entry and says nothing (#318).
      {
        type: "workflow",
        name: "VECTOR_REPROCESS",
        job: "reprocess",
        className: "VectorReprocessWorkflow",
        optional: true,
      },
    ]);
  });

  it("derives one Vectorize binding per index — a binding addresses exactly one index", () => {
    const capability = vector({
      indexes: {
        docs: { model: "m", dimensions: 8, metadata: DocMeta },
        notes: { model: "m", dimensions: 8, binding: "VECTORIZE_NOTES" },
      },
    });
    expect(capability.requiredBindings.filter((b) => b.type === "vectorize").map((b) => b.name)).toEqual([
      "VECTORIZE",
      "VECTORIZE_NOTES",
    ]);
  });

  it("refuses two indexes on one binding — every write to one would land in the other", () => {
    expect(() =>
      vector({ indexes: { docs: { model: "m", dimensions: 8 }, notes: { model: "m", dimensions: 8 } } }),
    ).toThrow(/both bind/);
  });

  it("registers the reprocess workflow and the example seed", () => {
    const capability = vector(options);
    expect(Object.keys(capability.workflows ?? {})).toEqual(["reprocess"]);
    expect(capability.seeds?.map((set) => set.name)).toEqual(["example"]);
    expect(capability.routes).toBeTypeOf("function");
  });

  it("contributes the document corpus to the app database at its own migration order", () => {
    const capability = vector(options);
    expect(capability.databases?.app?.migrationOrder).toBe(VECTOR_MIGRATION_ORDER);
    expect(Object.keys(capability.databases?.app?.tables ?? {})).toEqual([VECTOR_DOCUMENTS_TABLE]);
    expect(Object.keys(capability.databases?.app?.migrations ?? {})).toEqual(["0001_documents"]);
  });

  it("depends on nothing — auth is a seam, so a missing auth capability denies rather than opens", () => {
    expect(vector(options).dependsOn).toBeUndefined();
  });

  it("rejects a bad config at assembly, so a typo fails on deploy rather than on the first search", () => {
    expect(() => vector({ indexes: { docs: { model: "m", dimensions: 99_999 } } })).toThrow();
  });

  it("composes with no indexes, because that is the state `pithy add vector` leaves behind", () => {
    // `renderRegistration` seeds only scalar config options, so the generated pithy.config.ts has no
    // `indexes` block. Throwing here would make that file unloadable — and `loadProject` sits under
    // every other pithy command, including the migrate that `pithy add` runs next.
    expect(() => vector()).not.toThrow();
    expect(vector().vectorConfig.indexes).toEqual({});
  });
});

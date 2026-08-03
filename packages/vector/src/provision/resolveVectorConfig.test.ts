// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { WorkflowHostTemplate } from "@pithy-sh/core/src/workflow/host";
import { parse } from "comment-json";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { VectorConfig } from "../config/config";
import { VectorWorkerConfig } from "../config/workerConfig";
import { filterable } from "../index/filter";
import { resolveVectorConfig } from "./resolveVectorConfig";

/**
 * The resolver is tested against the **committed template**, not a fixture — a template edit that breaks the
 * deploy should break this test, which is the whole reason the template is a file rather than a string here.
 */

const template = parse(
  readFileSync(join(import.meta.dirname, "../workflows/wrangler.jsonc"), "utf8"),
) as unknown as WorkflowHostTemplate;

const metadata = z.object({
  ownerId: filterable(z.string().describe("Owner.")),
  title: z.string().describe("Title."),
});

const config = VectorConfig.parse({
  indexes: {
    docs: { model: "current-model", dimensions: 768, metadata },
    notes: { model: "other-model", dimensions: 384, binding: "VECTORIZE_NOTES" },
  },
});

const indexNames = { docs: "acme-staging-vector-docs", notes: "acme-staging-vector-notes" };

const resolved = resolveVectorConfig(template, {
  project: "acme",
  env: "staging",
  appDatabaseId: "db-1",
  indexNames,
  config,
});

describe("resolveVectorConfig", () => {
  it("names the worker and its Workflow for the project and the environment", () => {
    expect(resolved.name).toBe("acme-staging-vector");
    expect(resolved.workflows?.[0]).toEqual({
      binding: "VECTOR_REPROCESS",
      name: "acme-staging-vector-reprocess",
      class_name: "VectorReprocessWorkflow",
    });
  });

  it("a second project resolves to entirely different worker and Workflow names", () => {
    const other = resolveVectorConfig(template, {
      project: "globex",
      env: "staging",
      appDatabaseId: "db-1",
      indexNames,
      config,
    });
    expect(other.name).toBe("globex-staging-vector");
    expect(other.workflows?.[0]?.name).toBe("globex-staging-vector-reprocess");
  });

  it("binds the app database the corpus lives in", () => {
    expect(resolved.d1_databases?.[0]).toMatchObject({ binding: "DB", database_id: "db-1" });
  });

  it("rebuilds the vectorize array from the config — one binding per index, all remote", () => {
    expect(resolved.vectorize).toEqual([
      { binding: "VECTORIZE", index_name: "acme-staging-vector-docs", remote: true },
      { binding: "VECTORIZE_NOTES", index_name: "acme-staging-vector-notes", remote: true },
    ]);
  });

  it("marks Workers AI remote — a Workflow host runs locally, and AI has no local emulation", () => {
    expect(resolved.ai).toEqual({ binding: "AI", remote: true });
  });

  it("serializes the projected config, not the config — a Zod schema cannot travel through a var", () => {
    const raw = resolved.vars?.VECTOR_CONFIG;
    expect(raw).toBeTypeOf("string");
    const parsed = VectorWorkerConfig.parse(JSON.parse(raw as string));
    expect(parsed.indexes.docs?.indexName).toBe("acme-staging-vector-docs");
    expect(parsed.indexes.docs?.filterable).toEqual([{ propertyName: "ownerId", indexType: "string" }]);
  });

  it("stamps the environment so a deployed worker knows which one it is", () => {
    expect(resolved.vars?.ENVIRONMENT).toBe("staging");
  });

  it("leaves the committed template untouched", () => {
    expect(template.name).toBe("pithy-vector");
    expect(template.vectorize).toHaveLength(1);
  });
});

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

const indexNames = { docs: "pithy-vector-docs-staging", notes: "pithy-vector-notes-staging" };

const resolved = resolveVectorConfig(template, {
  env: "staging",
  appDatabaseId: "db-1",
  indexNames,
  config,
});

describe("resolveVectorConfig", () => {
  it("names the worker and its Workflow for the environment", () => {
    expect(resolved.name).toBe("pithy-vector-staging");
    expect(resolved.workflows?.[0]).toEqual({
      binding: "VECTOR_REPROCESS",
      name: "pithy-vector-reprocess-staging",
      class_name: "VectorReprocessWorkflow",
    });
  });

  it("binds the app database the corpus lives in", () => {
    expect(resolved.d1_databases?.[0]).toMatchObject({ binding: "DB", database_id: "db-1" });
  });

  it("rebuilds the vectorize array from the config — one binding per index, all remote", () => {
    expect(resolved.vectorize).toEqual([
      { binding: "VECTORIZE", index_name: "pithy-vector-docs-staging", remote: true },
      { binding: "VECTORIZE_NOTES", index_name: "pithy-vector-notes-staging", remote: true },
    ]);
  });

  it("marks Workers AI remote — a Workflow host runs locally, and AI has no local emulation", () => {
    expect(resolved.ai).toEqual({ binding: "AI", remote: true });
  });

  it("serializes the projected config, not the config — a Zod schema cannot travel through a var", () => {
    const raw = resolved.vars?.VECTOR_CONFIG;
    expect(raw).toBeTypeOf("string");
    const parsed = VectorWorkerConfig.parse(JSON.parse(raw as string));
    expect(parsed.indexes.docs?.indexName).toBe("pithy-vector-docs-staging");
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

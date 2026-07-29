import { readFileSync } from "node:fs";
import { join } from "node:path";
import { workflowScriptName } from "@pithy-sh/core/src/workflow/naming";
import { parse } from "comment-json";
import { describe, expect, it } from "vitest";
import { VECTOR_CAPABILITY, VectorReprocessParams, vectorWorkflowRegistry, vectorWorkflows } from "./specs";

/**
 * The specs are the single description of vector's durable work — the capability derives its binding from
 * them, the worker template hosts the class they name, and the CLI dispatches by the key they compose. This
 * test is what keeps those three from drifting: it checks the declaration against the committed template.
 */

const template = parse(readFileSync(join(import.meta.dirname, "wrangler.jsonc"), "utf8")) as unknown as {
  workflows: { binding: string; name: string; class_name: string }[];
};

describe("vectorWorkflows", () => {
  it("declares one job, keyed by its job name", () => {
    expect(Object.keys(vectorWorkflows)).toEqual(["reprocess"]);
  });

  it("is optional — the binding exists only after `pithy vector provision`", () => {
    expect(vectorWorkflows.reprocess.optional).toBe(true);
  });

  it("matches the committed host template's binding and class, which nothing else enforces", () => {
    expect(template.workflows).toEqual([
      {
        binding: vectorWorkflows.reprocess.binding,
        name: "pithy-vector-reprocess",
        class_name: vectorWorkflows.reprocess.className,
      },
    ]);
  });

  it("composes the deployed name core would derive for it", () => {
    expect(workflowScriptName(VECTOR_CAPABILITY, "reprocess", "staging")).toBe("pithy-vector-reprocess-staging");
  });

  it("registers under the `vector/reprocess` dispatch key", () => {
    expect(Object.keys(vectorWorkflowRegistry)).toEqual(["vector/reprocess"]);
    expect(vectorWorkflowRegistry["vector/reprocess"]?.capability).toBe(VECTOR_CAPABILITY);
  });
});

describe("VectorReprocessParams", () => {
  it("requires the index — a run covers one index", () => {
    expect(VectorReprocessParams.safeParse({}).success).toBe(false);
    expect(VectorReprocessParams.parse({ index: "docs" })).toEqual({ index: "docs" });
  });

  it("carries the scoping options a run accepts", () => {
    expect(
      VectorReprocessParams.parse({ index: "docs", all: true, filter: { ownerId: "ada" }, pageSize: 500 }),
    ).toEqual({ index: "docs", all: true, filter: { ownerId: "ada" }, pageSize: 500 });
  });
});

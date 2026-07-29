import { PithyError } from "@pithy-sh/core/src/error/pithyError";
import { describe, expect, it } from "vitest";
import { VectorIndexConfig } from "../config/config";
import { embedForIndex, embedTexts, type VectorAi } from "./embed";

const index = VectorIndexConfig.parse({ model: "@cf/baai/bge-base-en-v1.5", dimensions: 3 });

/** A fake Workers AI binding. There is no local emulation, so injection is the only way to test any of this. */
function fakeAi(response: unknown) {
  const calls: { model: string; input: Record<string, unknown> }[] = [];
  const ai: VectorAi = {
    run: async (model, input) => {
      calls.push({ model, input });
      return response;
    },
  };
  return { ai, calls };
}

async function codeOf(run: () => Promise<unknown>): Promise<string> {
  try {
    await run();
  } catch (error) {
    if (error instanceof PithyError) return error.payload.code;
    throw error;
  }
  throw new Error("expected a PithyError");
}

describe("embedTexts", () => {
  it("returns one vector per text, in order", async () => {
    const { ai, calls } = fakeAi({
      shape: [2, 3],
      data: [
        [1, 2, 3],
        [4, 5, 6],
      ],
    });
    expect(await embedTexts(ai, ["a", "b"], "m")).toEqual([
      [1, 2, 3],
      [4, 5, 6],
    ]);
    expect(calls[0]).toEqual({ model: "m", input: { text: ["a", "b"] } });
  });

  it("accepts a response with no shape — the data is what matters", async () => {
    const { ai } = fakeAi({ data: [[1, 2, 3]] });
    expect(await embedTexts(ai, ["a"], "m")).toEqual([[1, 2, 3]]);
  });

  it("rejects an empty batch", async () => {
    const { ai } = fakeAi({ data: [] });
    expect(await codeOf(() => embedTexts(ai, [], "m"))).toBe("validation/invalid_input");
  });

  it("refuses a response it does not recognize", async () => {
    const { ai } = fakeAi({ embeddings: [[1, 2, 3]] });
    expect(await codeOf(() => embedTexts(ai, ["a"], "m"))).toBe("core/internal");
  });

  it("refuses a response with the wrong number of vectors — a silent misalignment otherwise", async () => {
    const { ai } = fakeAi({ data: [[1, 2, 3]] });
    expect(await codeOf(() => embedTexts(ai, ["a", "b"], "m"))).toBe("core/internal");
  });
});

describe("embedForIndex", () => {
  it("uses the index's pinned model, so writes and queries share one embedding space", async () => {
    const { ai, calls } = fakeAi({ data: [[1, 2, 3]] });
    await embedForIndex(ai, index, ["a"]);
    expect(calls[0]?.model).toBe("@cf/baai/bge-base-en-v1.5");
  });

  it("rejects a vector the index cannot hold — a model swapped without re-creating the index", async () => {
    const { ai } = fakeAi({ data: [[1, 2, 3, 4]] });
    expect(await codeOf(() => embedForIndex(ai, index, ["a"]))).toBe("vector/dimension_mismatch");
  });
});

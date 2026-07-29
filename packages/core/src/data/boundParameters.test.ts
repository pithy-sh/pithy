import { describe, expect, test } from "vitest";
import { PithyError } from "../error/pithyError";
import { boundParameterBudget, chunkByBoundParameters, MAX_BOUND_PARAMETERS } from "./boundParameters";

/**
 * The arithmetic, asserted directly. The bug this guards against is a chunk sized at the cap itself:
 * every chunk then binds one parameter more than D1 allows, and no small test notices.
 */

describe("boundParameterBudget", () => {
  test("a statement with no other parameters may use the whole cap", () => {
    expect(boundParameterBudget(0)).toBe(MAX_BOUND_PARAMETERS);
  });

  test("every fixed parameter costs the list one slot", () => {
    expect(boundParameterBudget(1)).toBe(MAX_BOUND_PARAMETERS - 1);
    expect(boundParameterBudget(2)).toBe(MAX_BOUND_PARAMETERS - 2);
  });

  test("a chunk plus its statement's fixed parameters never exceeds the cap", () => {
    for (let fixed = 0; fixed < MAX_BOUND_PARAMETERS; fixed += 1) {
      expect(boundParameterBudget(fixed) + fixed).toBeLessThanOrEqual(MAX_BOUND_PARAMETERS);
    }
  });

  test("a statement with no room left is a bug, and says so", () => {
    expect(() => boundParameterBudget(MAX_BOUND_PARAMETERS)).toThrow(PithyError);
    expect(() => boundParameterBudget(MAX_BOUND_PARAMETERS + 1)).toThrow(PithyError);
  });

  test("a nonsense count is rejected rather than producing a nonsense chunk size", () => {
    expect(() => boundParameterBudget(-1)).toThrow(PithyError);
    expect(() => boundParameterBudget(1.5)).toThrow(PithyError);
  });

  test("the throw keeps its context internal, where the HTTP codec strips it", () => {
    try {
      boundParameterBudget(MAX_BOUND_PARAMETERS);
      expect.unreachable("expected a throw");
    } catch (error) {
      const payload = (error as PithyError).payload;
      expect(payload.code).toBe("core/internal");
      expect(payload.message).not.toContain("D1");
      expect(payload.detail).toContain("D1");
    }
  });
});

describe("chunkByBoundParameters", () => {
  test("chunks fit under the cap alongside the statement's own parameters", () => {
    const ids = Array.from({ length: 250 }, (_, index) => index);
    const chunks = chunkByBoundParameters(ids, 2);
    expect(chunks.flat()).toEqual(ids);
    for (const group of chunks) expect(group.length + 2).toBeLessThanOrEqual(MAX_BOUND_PARAMETERS);
  });

  test("a full chunk uses every slot the budget leaves — chunking is not over-cautious", () => {
    const ids = Array.from({ length: 250 }, (_, index) => index);
    expect(chunkByBoundParameters(ids, 1)[0]?.length).toBe(MAX_BOUND_PARAMETERS - 1);
  });

  test("nothing in, nothing out — the caller's loop simply does not run", () => {
    expect(chunkByBoundParameters([], 1)).toEqual([]);
  });
});

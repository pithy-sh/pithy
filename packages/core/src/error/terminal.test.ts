// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { describe, expect, test } from "vitest";
import { HttpError } from "./http";
import { ForbiddenError, InternalError } from "./pithyError";
import { operatorError, renderTerminal } from "./terminal";

describe("renderTerminal", () => {
  test("renders message as the problem line and action as the action line", () => {
    const err = new ForbiddenError({ message: "Forbidden.", action: "Ask an admin for access." });
    expect(renderTerminal(err.payload)).toBe("Forbidden.\nAsk an admin for access.");
  });

  test("renders just the problem line when there is no action", () => {
    const err = new InternalError();
    expect(renderTerminal(err.payload)).toBe("Something unexpected happened.");
  });

  test("never includes internal detail", () => {
    const err = new ForbiddenError({ message: "No.", detail: "user 5 lacks role:admin" });
    expect(renderTerminal(err.payload)).not.toContain("user 5");
  });
});

describe("operatorError", () => {
  test("keeps the remedy — the operator is who it was written for", () => {
    const err = new ForbiddenError({
      message: "No.",
      action: "Bind a D1 database named DB in wrangler.jsonc.",
      detail: "user 5 lacks role:admin",
    });
    expect(operatorError(err.payload)).toEqual({
      code: "auth/forbidden",
      status: 403,
      message: "No.",
      action: "Bind a D1 database named DB in wrangler.jsonc.",
    });
  });

  test("drops `detail` — the same field, on both surfaces", () => {
    const err = new InternalError({ message: "Broke.", detail: "SECRETS_ENCRYPTION_KEYS unbound on pithy-prod" });
    const json = JSON.stringify(operatorError(err.payload));
    expect(json).not.toContain("SECRETS_ENCRYPTION_KEYS");
    expect(json).not.toContain("pithy-prod");
  });

  test("omits the key entirely when there is no remedy, rather than stating undefined", () => {
    expect(Object.hasOwn(operatorError(new InternalError({ message: "Broke." }).payload), "action")).toBe(false);
  });

  test("the two surfaces differ by exactly the remedy, and by nothing else", () => {
    // The claim the split rests on. If these ever agree on `action`, one of the two audiences is
    // being served the other's sentence — which is the defect #344 was filed for.
    const payload = new ForbiddenError({ message: "No.", action: "Run pithy doctor.", detail: "trace" }).payload;
    const operator = operatorError(payload);
    const wire = HttpError.encode(payload);
    expect(Object.hasOwn(operator, "action")).toBe(true);
    expect(Object.hasOwn(wire, "action")).toBe(false);
    const { action: _action, ...operatorWithoutRemedy } = operator;
    expect(operatorWithoutRemedy).toEqual(wire);
  });
});

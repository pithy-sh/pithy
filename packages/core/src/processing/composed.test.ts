// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { afterEach, describe, expect, test } from "vitest";
import { defineCapability } from "../capability/capability";
import { createBackend } from "../createBackend";
import { composedProcessing, effectiveProcessing, forgetProcessing } from "./composed";

const auth = defineCapability({
  name: "auth",
  requiredBindings: [],
  processing: [{ id: "auth.account", purpose: "Keep an account.", classes: ["pii"], legalBasis: "contract" }],
});

afterEach(() => forgetProcessing());

describe("effectiveProcessing", () => {
  test("parses and resolves a block over a composition", () => {
    const resolved = effectiveProcessing({ overrides: { "auth.account": { legalBasis: "legitimate-interests" } } }, [
      auth,
    ]);
    expect(resolved[0]).toMatchObject({ legalBasis: "legitimate-interests", basisSource: "config" });
  });
});

describe("createBackend", () => {
  test("records the processing as this Worker resolved it, so the control plane reads one record", () => {
    expect(composedProcessing()).toBeNull();
    createBackend({
      capabilities: [auth],
      processing: { activities: [{ id: "clinic.intake", purpose: "Take a history.", classes: ["phi"] }] },
    });
    expect(composedProcessing()?.map((activity) => activity.id)).toEqual(["auth.account", "clinic.intake"]);
  });

  test("refuses to assemble a Worker whose processing block overrides an activity nothing declares", () => {
    expect(() =>
      createBackend({ capabilities: [auth], processing: { overrides: { "ghost.thing": { legalBasis: "contract" } } } }),
    ).toThrow(/no composed capability declares/);
  });
});

// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { describe, expect, test } from "vitest";
import { PithyError } from "../error/pithyError";
import { type Capability, defineCapability } from "./capability";
import { type PurgeContribution, PurgeSubject, purgeSteps } from "./purge";

/** A contribution that records the subject it was asked to erase, so a test can see it ran. */
function recording(seen: string[], summary = "Erases this capability's rows for one user."): PurgeContribution {
  return {
    subject: "user",
    summary,
    erase: async ({ subject }) => {
      seen.push(subject.id);
    },
  };
}

describe("the purge contribution on the Capability contract", () => {
  test("defineCapability accepts one, and hands it back unchanged", () => {
    const seen: string[] = [];
    const contribution = recording(seen);
    const capability = defineCapability({ name: "media", requiredBindings: [], purge: [contribution] });
    expect(capability.purge).toEqual([contribution]);
  });

  test("a capability that erases nothing declares nothing, which is the ordinary case", () => {
    expect(defineCapability({ name: "turnstile", requiredBindings: [] }).purge).toBeUndefined();
  });

  test("one declared for a subject the kit does not know is refused at define time, naming it", () => {
    // A typo'd subject would otherwise be a contribution no purge ever asks for — rows nobody erases,
    // with a declaration in the source saying they are.
    const unknown = { ...recording([]), subject: "users" } as unknown as PurgeContribution;
    expect(() => defineCapability({ name: "media", requiredBindings: [], purge: [unknown] })).toThrow(PithyError);
    expect(() => defineCapability({ name: "media", requiredBindings: [], purge: [unknown] })).toThrow(/"users"/);
  });

  test("two for the same subject from one capability are refused — one capability is one step", () => {
    // The Workflow runs a step per capability so a failure retries one capability alone. Two
    // contributions for one subject would have to share that step, and a retry would re-run both.
    expect(() =>
      defineCapability({ name: "media", requiredBindings: [], purge: [recording([]), recording([])] }),
    ).toThrow(/media.*user/);
  });

  test("a contribution with no summary is refused, because the summary is what the step records", () => {
    expect(() => defineCapability({ name: "media", requiredBindings: [], purge: [recording([], "")] })).toThrow(
      PithyError,
    );
  });

  test("the subject vocabulary is closed, and today it is one word", () => {
    expect(PurgeSubject.options).toEqual(["user"]);
  });
});

describe("purgeSteps", () => {
  test("one step per composed capability that declared one, in composition order, named for it", async () => {
    const seen: string[] = [];
    const capabilities: Capability[] = [
      defineCapability({ name: "auth", requiredBindings: [], purge: [recording(seen)] }),
      defineCapability({ name: "turnstile", requiredBindings: [] }),
      defineCapability({ name: "media", requiredBindings: [], purge: [recording(seen)] }),
      defineCapability({ name: "app", requiredBindings: [], purge: [recording(seen, "Erases the adopter's tables.")] }),
    ];
    const steps = purgeSteps(capabilities, "user");
    expect(steps.map((step) => step.step)).toEqual(["auth", "media", "app"]);
    for (const step of steps) await step.contribution.erase({ subject: { type: "user", id: "u1" }, env: {} });
    expect(seen).toEqual(["u1", "u1", "u1"]);
  });

  test("a project that composes no contribution has no steps, not an error", () => {
    expect(purgeSteps([defineCapability({ name: "turnstile", requiredBindings: [] })], "user")).toEqual([]);
  });
});

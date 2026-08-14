// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { afterEach, describe, expect, test } from "vitest";
import { type Capability, defineCapability } from "./capability";
import { composedCapabilities, composedCapability, forgetComposition, recordComposition } from "./composition";

/**
 * The composed set, as a Workflow step finds it (pithy-sh/pithy#356).
 *
 * The end-to-end proof — an actual durable job sending actual mail through the composed identity — is
 * `@pithy-sh/email`'s `send/aWorkflowCanSend.workers.test.ts`, because that is where the capability with
 * a seam worth reaching lives. This file holds the three things that decide whether that proof means
 * anything: an un-composed isolate raises rather than answering emptily, a capability composed without
 * its seams is a miss rather than a hit, and a second assembly replaces rather than merges.
 */

/** A capability carrying a seam, and a guard that checks for the seam rather than the name. */
interface Seamed {
  seam: () => string;
}
const hasSeam = (capability: unknown): boolean => typeof (capability as Seamed).seam === "function";

function seamed(name: string, answer: string) {
  return Object.assign(defineCapability({ name, requiredBindings: [] }), { seam: () => answer });
}

afterEach(forgetComposition);

describe("composedCapabilities", () => {
  test("raises before any backend has been assembled, rather than answering with nothing", () => {
    forgetComposition();
    expect(() => composedCapabilities()).toThrowError(/could not reach/i);
  });

  test("answers with what was recorded", () => {
    recordComposition([
      defineCapability({ name: "alpha", requiredBindings: [] }),
      defineCapability({ name: "beta", requiredBindings: [] }),
    ]);
    expect(composedCapabilities().map((capability) => capability.name)).toEqual(["alpha", "beta"]);
  });

  test("a second assembly replaces the first — a half-remembered composition is worse than none", () => {
    recordComposition([defineCapability({ name: "alpha", requiredBindings: [] })]);
    recordComposition([defineCapability({ name: "beta", requiredBindings: [] })]);
    expect(composedCapabilities().map((capability) => capability.name)).toEqual(["beta"]);
  });

  test("the recorded set is a copy: mutating the caller's array afterwards changes nothing", () => {
    const capabilities: Capability[] = [defineCapability({ name: "alpha", requiredBindings: [] })];
    recordComposition(capabilities);
    capabilities.push(defineCapability({ name: "smuggled", requiredBindings: [] }));
    expect(composedCapabilities().map((capability) => capability.name)).toEqual(["alpha"]);
  });
});

describe("composedCapability", () => {
  test("finds one by name and hands back its seam", () => {
    recordComposition([defineCapability({ name: "other", requiredBindings: [] }), seamed("email", "sent")]);
    expect(composedCapability<ReturnType<typeof seamed>>("email", hasSeam).seam()).toBe("sent");
  });

  test("names the missing capability in the client-safe half, so the fault can be acted on", () => {
    recordComposition([defineCapability({ name: "other", requiredBindings: [] })]);
    expect(() => composedCapability("email", hasSeam)).toThrowError(/"email" capability is not composed/);
  });

  test("a capability composed under the right name but carrying no seams is a miss, not a hit", () => {
    // The failure this forbids: returning the bare capability, so the call site's `enqueue` is
    // undefined and the fault surfaces as a TypeError somewhere else entirely.
    recordComposition([defineCapability({ name: "email", requiredBindings: [] })]);
    expect(() => composedCapability("email", hasSeam)).toThrowError(/not composed/);
  });

  test("anti-vacuity: the same guard and name succeed the moment the seam is there", () => {
    recordComposition([seamed("email", "sent")]);
    expect(() => composedCapability("email", hasSeam)).not.toThrow();
  });
});

// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { describe, expect, test } from "vitest";
import { PinnedBindings, readDeclinedBindings, readPinnedBindings, type WorkerConfig } from "./config";

/**
 * A Worker's `pinnedBindings` declaration, as the reconcile engine reads it (#499).
 *
 * The neighboring declaration to `declinedBindings`, read by the same three-branch reader, so this file
 * is about what is genuinely per declaration: the key, its near misses, and that the two cannot be
 * confused for one another. The reason rules themselves are `declinedBindings.test.ts`'s subject — one
 * schema, one set of cases — and the last test here is what keeps that sharing honest.
 */

/** A worker config with the one member `isWorkerConfig` duck-types, plus whatever the case is about. */
function config(extra: Record<string, unknown> = {}): WorkerConfig {
  return { capabilities: [], ...extra } as unknown as WorkerConfig;
}

describe("a declaration that is absent or empty", () => {
  test("absent reads as pinning nothing", () => {
    // The ordinary state of every Worker whose generated values are whatever the kit last wrote.
    expect(readPinnedBindings(config())).toEqual({ state: "read", declared: {} });
  });

  test("null reads the same as absent", () => {
    expect(readPinnedBindings(config({ pinnedBindings: null }))).toEqual({ state: "read", declared: {} });
  });
});

describe("a well-formed declaration", () => {
  test("reads the binding name and its reason", () => {
    const read = readPinnedBindings(config({ pinnedBindings: { AUTH_RATE_LIMITER: "20/60 matches our quota" } }));
    expect(read).toEqual({ state: "read", declared: { AUTH_RATE_LIMITER: "20/60 matches our quota" } });
  });

  test("a reason left blank is refused, because a pin with no reason is the silence it dismisses", () => {
    // The whole point of the required reason, one level along from #440: a value that merely differs is
    // indistinguishable from one nobody looked at, and a pin with no sentence says exactly as little.
    expect(readPinnedBindings(config({ pinnedBindings: { AUTH_RATE_LIMITER: "" } })).state).toBe("invalid");
  });

  test("the problem names the binding, so the adopter knows which line to fix", () => {
    const read = readPinnedBindings(config({ pinnedBindings: { AUTH_RATE_LIMITER: "" } }));
    expect(read.state === "invalid" && read.problem).toContain("AUTH_RATE_LIMITER");
  });
});

describe("a key that was meant to be this one", () => {
  test.each([
    ["pinnedBinding", "the singular"],
    ["pinBindings", "the wrong tense"],
    ["pinned_bindings", "snake case"],
    ["PinnedBindings", "the type's name"],
  ])("%s is refused by name — %s", (key) => {
    // A pin nothing reads costs the adopter their dismissal and puts the difference back on every run,
    // with nothing anywhere saying why.
    const read = readPinnedBindings(config({ [key]: { AUTH_RATE_LIMITER: "ours" } }));
    expect(read.state).toBe("invalid");
    expect(read.state === "invalid" && read.problem).toContain(key);
    expect(read.state === "invalid" && read.problem).toContain("pinnedBindings");
  });

  test("an adopter's own unrelated key is left alone", () => {
    expect(readPinnedBindings(config({ domains: [], myOwnThing: 1 }))).toEqual({ state: "read", declared: {} });
  });
});

describe("the two declarations are read apart", () => {
  test("a decline is not a pin, and a pin is not a decline", () => {
    // One reader serves both, so the parameter that separates them is load-bearing: passing the wrong
    // key would make every Worker's declines its pins, silently, in both directions.
    const declining = config({ declinedBindings: { SUPPORT_BUCKET: "no R2 yet" } });
    expect(readPinnedBindings(declining)).toEqual({ state: "read", declared: {} });

    const pinning = config({ pinnedBindings: { AUTH_RATE_LIMITER: "ours" } });
    expect(readDeclinedBindings(pinning)).toEqual({ state: "read", declared: {} });
  });

  test("neither key is a near miss of the other", () => {
    expect(readPinnedBindings(config({ declinedBindings: { A: "why" } })).state).toBe("read");
    expect(readDeclinedBindings(config({ pinnedBindings: { A: "why" } })).state).toBe("read");
  });
});

describe("the schema itself", () => {
  test("every field carries a description, because the schemas are the object model's documentation", () => {
    expect(PinnedBindings.description).toBeTruthy();
  });
});

// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { describe, expect, test } from "vitest";
import { DeclinedBindings, readDeclinedBindings, type WorkerConfig } from "./config";

/**
 * A Worker's `declinedBindings` declaration, as the reconcile engine reads it.
 *
 * This is the adopter's own TypeScript, and the scaffolded `const config = { … }` carries no type
 * annotation — so nothing between the keyboard and here rejects a misspelling or a reason left blank.
 * Every case below is a shape that would otherwise reach `pithy upgrade` and be honored, ignored, or
 * printed as garbage.
 */

/** A worker config with the one member `isWorkerConfig` duck-types, plus whatever the case is about. */
function config(extra: Record<string, unknown> = {}): WorkerConfig {
  return { capabilities: [], ...extra } as unknown as WorkerConfig;
}

describe("a declaration that is absent or empty", () => {
  test("absent reads as declining nothing", () => {
    // The ordinary state of every Worker. It must not be an error and must not be a distinct state
    // downstream — a Worker that declines nothing and one that declares an empty record are the same
    // Worker, and giving them two states would give doctor two lines to print for one fact.
    expect(readDeclinedBindings(config())).toEqual({ state: "read", declared: {} });
  });

  test("null reads the same as absent", () => {
    // `declinedBindings: undefined` survives a spread; `null` is what a JSON round-trip produces.
    expect(readDeclinedBindings(config({ declinedBindings: null }))).toEqual({ state: "read", declared: {} });
  });

  test("an empty record reads as declining nothing", () => {
    expect(readDeclinedBindings(config({ declinedBindings: {} }))).toEqual({ state: "read", declared: {} });
  });
});

describe("a well-formed declaration", () => {
  test("reads the binding name and its reason", () => {
    const read = readDeclinedBindings(config({ declinedBindings: { SUPPORT_BUCKET: "no R2 in this account yet" } }));
    expect(read).toEqual({ state: "read", declared: { SUPPORT_BUCKET: "no R2 in this account yet" } });
  });

  test("trims the reason, because the terminal report is fixed-width", () => {
    const read = readDeclinedBindings(config({ declinedBindings: { SUPPORT_BUCKET: "  no bucket yet  " } }));
    expect(read).toEqual({ state: "read", declared: { SUPPORT_BUCKET: "no bucket yet" } });
  });

  test("carries more than one", () => {
    const read = readDeclinedBindings(config({ declinedBindings: { A_ONE: "first", B_TWO: "second" } }));
    expect(read.state === "read" && Object.keys(read.declared)).toEqual(["A_ONE", "B_TWO"]);
  });
});

describe("a declaration that cannot be honored", () => {
  test("a reason left blank is refused, not treated as a decline with no reason", () => {
    // The whole point of the required reason. An empty string reads as a decline everywhere
    // downstream and prints as a bare dash, which is the silence #440 exists to remove.
    const read = readDeclinedBindings(config({ declinedBindings: { SUPPORT_BUCKET: "" } }));
    expect(read.state).toBe("invalid");
  });

  test("whitespace alone is refused too", () => {
    expect(readDeclinedBindings(config({ declinedBindings: { SUPPORT_BUCKET: "   " } })).state).toBe("invalid");
  });

  test("a multi-line reason is refused, because the report gives it one line", () => {
    const read = readDeclinedBindings(config({ declinedBindings: { SUPPORT_BUCKET: "no bucket\nyet" } }));
    expect(read.state).toBe("invalid");
  });

  test("a reason past 160 characters is refused", () => {
    expect(readDeclinedBindings(config({ declinedBindings: { A: "x".repeat(161) } })).state).toBe("invalid");
    expect(readDeclinedBindings(config({ declinedBindings: { A: "x".repeat(160) } })).state).toBe("read");
  });

  test("a non-string reason is refused rather than stringified", () => {
    expect(readDeclinedBindings(config({ declinedBindings: { A: true } })).state).toBe("invalid");
    expect(readDeclinedBindings(config({ declinedBindings: { A: { why: "no" } } })).state).toBe("invalid");
  });

  test("an array is refused — the shape is a record keyed by binding name", () => {
    expect(readDeclinedBindings(config({ declinedBindings: ["SUPPORT_BUCKET"] })).state).toBe("invalid");
  });

  test("the problem names the binding, so the adopter knows which line to fix", () => {
    const read = readDeclinedBindings(config({ declinedBindings: { SUPPORT_BUCKET: "" } }));
    expect(read.state === "invalid" && read.problem).toContain("SUPPORT_BUCKET");
  });
});

describe("a key that was meant to be this one", () => {
  test.each([
    ["declinedBinding", "the singular"],
    ["declineBindings", "the wrong tense"],
    ["declined_bindings", "snake case"],
    ["DeclinedBindings", "the type's name"],
  ])("%s is refused by name — %s", (key) => {
    // The scaffolded config literal is unannotated, so TypeScript accepts every one of these and
    // nothing reads them. Without this check the binding comes back on the next upgrade and no line
    // anywhere says why, which is the exact silence the feature removes.
    const read = readDeclinedBindings(config({ [key]: { SUPPORT_BUCKET: "no" } }));
    expect(read.state).toBe("invalid");
    expect(read.state === "invalid" && read.problem).toContain(key);
    expect(read.state === "invalid" && read.problem).toContain("declinedBindings");
  });

  test("an adopter's own unrelated key is left alone", () => {
    // The check must not become a whitelist of what a config may contain. `domains` and `app` are
    // real members, and anything else is the adopter's business.
    const read = readDeclinedBindings(config({ domains: [], app: undefined, myOwnThing: 1, bindings: {} }));
    expect(read).toEqual({ state: "read", declared: {} });
  });

  test("the correct key is never treated as a near miss", () => {
    expect(readDeclinedBindings(config({ declinedBindings: { A: "why" } })).state).toBe("read");
  });
});

describe("the schema itself", () => {
  test("every field carries a description, because the schemas are the object model's documentation", () => {
    expect(DeclinedBindings.description).toBeTruthy();
  });
});

// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { describe, expect, test } from "vitest";
import { keysIn, leavesIn, unpublishedIn } from "./published";

/**
 * The gate's own gate.
 *
 * Every surface using {@link unpublishedIn} plants a field against it once and reports the failure. This
 * file is the permanent version of that plant: a widening of **every JSON type** is refused here, on
 * every run, so the primitive cannot go quietly blind to one the way its first draft was blind to
 * booleans and nulls.
 */

/** A response the way a surface would declare one: three keys, three published facts. */
const PUBLISHED = {
  leaves: ["ada", "pro", true, null, 42],
  keys: ["user", "entitlement", "granted", "expiresAt", "seats"],
};

const CLEAN = { user: "ada", entitlement: "pro", granted: true, expiresAt: null, seats: 42 };

describe("unpublishedIn", () => {
  test("a projection carrying only its published facts reports nothing", () => {
    expect(unpublishedIn(CLEAN, PUBLISHED)).toEqual([]);
  });

  test("a widening of every JSON type is refused, and the type is named in the failure", () => {
    // One field at a time, of each type JSON has. A gate blind to any one of these is the defect this
    // primitive exists to end: `{ apple: true }` is what a "which stores is this on" field looks like,
    // and it is the cheapest widening there is.
    const plants: Record<string, unknown> = {
      string: "sk_live_51NxSecret",
      number: 4242,
      // `true`, `false` and `null` are in every JSON document's vocabulary, so the leaf half cannot
      // police them. The key half is what does, and these three are why there are two halves.
      "boolean true": true,
      "boolean false": false,
      null: null,
      object: { nested: "sk_live_51NxSecret" },
      array: ["sk_live_51NxSecret"],
    };
    for (const [label, planted] of Object.entries(plants)) {
      const found = unpublishedIn({ ...CLEAN, payload: planted }, PUBLISHED);
      expect(found, `a planted ${label} crossed the gate`).not.toEqual([]);
      expect(
        found.some((line) => line.startsWith('key "payload"')),
        `a planted ${label}`,
      ).toBe(true);
    }
  });

  test("a forbidden value under a permitted key is refused — a field is not a licence for its contents", () => {
    // The other half. `entitlement` is declared, so the key check is satisfied; the value is not a fact
    // this surface publishes, which is the shape of a projection that started selecting a new column.
    expect(unpublishedIn({ ...CLEAN, entitlement: "sk_live_51NxSecret" }, PUBLISHED)).toEqual([
      'value "sk_live_51NxSecret" at entitlement',
    ]);
  });

  test("the leaf half polices booleans and nulls too, and it is this test that says so", () => {
    // The previous test is satisfied by the key half alone, so it passes against a walk that skips every
    // type but string and number — which is precisely the walk this primitive replaced. Here the key is
    // permitted and only the leaf check can refuse, so a walk blind to a JSON type fails on this line.
    const narrow = { leaves: ["ada"], keys: ["user", "granted", "expiresAt", "seats"] };
    expect(unpublishedIn({ user: "ada", granted: true }, narrow)).toEqual(["value true at granted"]);
    expect(unpublishedIn({ user: "ada", granted: false }, narrow)).toEqual(["value false at granted"]);
    expect(unpublishedIn({ user: "ada", expiresAt: null }, narrow)).toEqual(["value null at expiresAt"]);
    expect(unpublishedIn({ user: "ada", seats: 42 }, narrow)).toEqual(["value 42 at seats"]);
  });

  test("it reaches into arrays and nested objects, and says where", () => {
    const document = { user: "ada", seats: [42, 7], entitlement: { granted: "leaked" } };
    expect(unpublishedIn(document, PUBLISHED)).toEqual([
      "value 7 at seats[1]",
      'value "leaked" at entitlement.granted',
    ]);
  });

  test("a permission is a set, not a subset — a key removed from the response leaves no hole", () => {
    // Permissions are declared, so an unused one is silent here on purpose: the surface's own test is
    // what asserts the declared set and the schema still agree in both directions.
    expect(unpublishedIn({ user: "ada" }, PUBLISHED)).toEqual([]);
  });

  test("a value JSON cannot express is refused rather than skipped", () => {
    // The fallthrough that returned `[]` for every unnameable type *was* the defect. A live object with
    // an `undefined` field is not what a client receives, and guessing at it is how a whole type goes
    // unpoliced. It throws, and the message says what to do.
    expect(() => unpublishedIn({ user: "ada", token: undefined }, PUBLISHED)).toThrow(/undefined sits at token/);
    expect(() => unpublishedIn({ user: "ada", mint: () => "x" }, PUBLISHED)).toThrow(/function sits at mint/);
    expect(() => unpublishedIn({ user: "ada", seats: 1n }, PUBLISHED)).toThrow(/bigint sits at seats/);
  });

  test("an object whose contents the walk cannot see is refused, and `typeof` is not what decides", () => {
    // The same fallthrough, arriving through the one branch that was believed safe. `typeof` answers
    // "object" for a `Date`, a `Map`, and every class instance, and each of those walks to no keys and
    // no leaves — so the descent itself grants the exemption, silently, to whatever they carry. A
    // `Map`'s entries are not own properties. A getter lives on the prototype. Neither is reachable
    // from `Object.entries`, and a gate that cannot see a value cannot police it.
    class Row {
      get token(): string {
        return "sk_live_51NxSecret";
      }
    }
    const unnameable: Record<string, [unknown, RegExp]> = {
      Date: [new Date("2026-06-10T12:00:00.000Z"), /Date sits at payload/],
      Map: [new Map([["k", "sk_live_51NxSecret"]]), /Map sits at payload/],
      Set: [new Set(["sk_live_51NxSecret"]), /Set sits at payload/],
      "class instance": [new Row(), /Row sits at payload/],
    };
    for (const [label, [planted, named]] of Object.entries(unnameable)) {
      // Under `payload`, which the declaration does not permit: the key half would refuse this one on
      // its own, so it proves nothing about the descent.
      expect(() => unpublishedIn({ ...CLEAN, payload: planted }, PUBLISHED), label).toThrow(named);
      // And under `user`, which it does: here nothing but the descent can refuse, so a walk that
      // exempts the type passes this line with an empty result.
      expect(() => unpublishedIn({ user: planted }, PUBLISHED), label).toThrow(/sits at user/);
    }
  });

  test("an array is walked because it is one, not because `Array.isArray` says so", () => {
    // A subclass is an array to `Array.isArray` and carries own properties the index walk never
    // visits. Same exemption, one branch over.
    class Rows extends Array<string> {
      readonly cursor: string = "sk_live_51NxSecret";
    }
    expect(() => unpublishedIn({ user: new Rows() }, PUBLISHED)).toThrow(/Rows sits at user/);
  });

  test("a container is one whose contents are all visible, which a null prototype's are", () => {
    // The rule is what the walk can see, and an object with no prototype has nowhere else to keep
    // anything. Refusing it would make the rule "is it `Object.prototype`" — a different rule, passing
    // every test above, and wrong about the one value that is strictly easier to police than a plain
    // object.
    const bare: Record<string, unknown> = Object.create(null);
    bare.payload = "sk_live_51NxSecret";
    expect(unpublishedIn({ user: bare }, PUBLISHED)).toEqual([
      'key "payload" at user.payload',
      'value "sk_live_51NxSecret" at user.payload',
    ]);
  });

  test("what a client receives still walks — the refusal is of live objects, not of documents", () => {
    // The anti-vacuity half. A gate that refused everything would pass every test above, so this says
    // the round-trip the message prescribes is a document this walk reads: the `Date` becomes the
    // string it serialises as, and the string is caught by the leaf half rather than exempted.
    const live = { user: "ada", payload: new Date("2026-06-10T12:00:00.000Z") };
    const crossed: unknown = JSON.parse(JSON.stringify(live));
    expect(unpublishedIn(crossed, PUBLISHED)).toEqual([
      'key "payload" at payload',
      'value "2026-06-10T12:00:00.000Z" at payload',
    ]);
  });
});

describe("leavesIn and keysIn", () => {
  test("every leaf of every type, wherever it sits", () => {
    expect(leavesIn({ a: "x", b: [1, true], c: { d: null }, e: false })).toEqual(["x", 1, true, null, false]);
  });

  test("every key, at every depth", () => {
    expect(keysIn({ a: { b: [{ c: 1 }] } })).toEqual(["a", "b", "c"]);
  });

  test("both refuse what they cannot see rather than reporting it empty", () => {
    // These two are how a caller builds the declaration it then policies itself against, so a value
    // they walk to nothing is worse here than in the gate: it becomes a permitted set that quietly
    // omits a field, and the sweep that follows agrees with it.
    expect(() => leavesIn({ at: new Date("2026-06-10T12:00:00.000Z") })).toThrow(/Date sits at/);
    expect(() => keysIn({ m: new Map([["k", "v"]]) })).toThrow(/Map sits at/);
  });
});

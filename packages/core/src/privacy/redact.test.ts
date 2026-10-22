// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { describe, expect, test } from "vitest";
import { z } from "zod";
import { SQLiteBoolean, SQLiteDate, sqliteJson } from "../data/codecs";
import { LogRecord, serializeRecord } from "../logger/record";
import { definePrivacyClass, pci, phi, pii, secret } from "./classes";
import { classifyPrivacy, hasPrivacy } from "./classify";
import { redact } from "./redact";
import type { ContainsMarked, REDACT_TYPE_DEPTH, Redacted } from "./types";

const User = z
  .object({
    id: z.string().describe("The user's stable id."),
    email: pii(z.string().describe("The address sign-in links are sent to.")),
    diagnosis: phi(z.string().describe("The recorded condition.")),
  })
  .describe("A user.");

const ada = User.parse({ id: "u_1", email: "ada@example.com", diagnosis: "asthma" });

/** Every raw marked value the tests put in a value starts `S-`: none may come back, as a value or as a key. */
function raw(value: unknown, seen = new Set<unknown>()): string[] {
  if (typeof value === "string") return value.startsWith("S-") ? [value] : [];
  if (typeof value !== "object" || value === null || seen.has(value)) return [];
  seen.add(value);
  const parts: unknown[] =
    value instanceof Map ? [...value].flat() : value instanceof Set ? [...value] : Object.entries(value).flat();
  return parts.flatMap((part) => raw(part, seen));
}

/** `redact` over what `parse` returns, as a caller hands it the app value. */
function masked(schema: z.ZodType, wire: unknown): unknown {
  return redact(schema, schema.parse(wire) as never);
}

describe("redact", () => {
  test("returns every unmarked field verbatim and masks each marked one with its class", () => {
    expect(redact(User, ada)).toEqual({ id: "u_1", email: "[pii]", diagnosis: "[phi]" });
  });

  test("leaves the value it was handed alone", () => {
    redact(User, ada);
    expect(ada.email).toBe("ada@example.com");
  });

  test("is loggable, and the record it lands in parses after serialization", () => {
    const record = { level: "info" as const, msg: "signup", time: 1, fields: { user: redact(User, ada) } };
    const parsed = LogRecord.parse(JSON.parse(serializeRecord(record)));
    expect(parsed.fields).toEqual({ user: { id: "u_1", email: "[pii]", diagnosis: "[phi]" } });
  });

  test("handles nested objects, arrays of objects, and a marked field inside an optional block", () => {
    const Account = z
      .object({
        owner: User.describe("Who owns it."),
        members: z.array(User).describe("Everyone on it."),
        billing: z
          .object({ card: pci(z.string().describe("The card.")), plan: z.string().describe("The plan.") })
          .optional()
          .describe("Billing, when set up."),
      })
      .describe("An account.");
    const value = Account.parse({
      owner: { id: "u_1", email: "ada@example.com", diagnosis: "asthma" },
      members: [
        { id: "u_2", email: "bob@example.com", diagnosis: "none" },
        { id: "u_3", email: "cy@example.com", diagnosis: "flu" },
      ],
      billing: { card: "4242 4242 4242 4242", plan: "pro" },
    });
    expect(redact(Account, value)).toEqual({
      owner: { id: "u_1", email: "[pii]", diagnosis: "[phi]" },
      members: [
        { id: "u_2", email: "[pii]", diagnosis: "[phi]" },
        { id: "u_3", email: "[pii]", diagnosis: "[phi]" },
      ],
      billing: { card: "424242******4242", plan: "pro" },
    });
    expect(redact(Account, Account.parse({ ...value, billing: undefined })).billing).toBeUndefined();
  });

  test("masks a pci value to first six and last four rather than to a placeholder", () => {
    const Card = z.object({ pan: pci(z.string().describe("The PAN.")) }).describe("A card.");
    expect(redact(Card, Card.parse({ pan: "4111111111111111" }))).toEqual({ pan: "411111******1111" });
  });

  test("keeps an absent marked field absent, and a null one null", () => {
    const Shape = z
      .object({
        nickname: pii(z.string()).nullable().describe("A nickname."),
        phone: pii(z.string()).optional().describe("A phone."),
      })
      .describe("A shape.");
    expect(redact(Shape, Shape.parse({ nickname: null }))).toEqual({ nickname: null });
  });

  test("masks a marked codec field with its class's own mask", () => {
    const Row = z
      .object({ bornAt: pii(SQLiteDate).describe("Date of birth."), smoker: phi(SQLiteBoolean).describe("Smokes.") })
      .describe("A row.");
    expect(masked(Row, { bornAt: 0, smoker: 1 })).toEqual({ bornAt: "[pii]", smoker: "[phi]" });
  });

  test("reads a JSON column field by field, through the kit's codec", () => {
    const Profile = z.object({ phone: pii(z.string()), city: z.string() });
    const Row = z.object({ id: z.string(), profile: sqliteJson(Profile), seen: SQLiteDate });
    const row = masked(Row, { id: "u_1", profile: JSON.stringify({ phone: "S-1", city: "Oslo" }), seen: 0 });
    expect(row).toEqual({ id: "u_1", profile: { phone: "[pii]", city: "Oslo" }, seen: new Date(0) });
  });

  test("masks a whole marked object", () => {
    const Visit = z.object({ notes: phi(z.object({ text: z.string() })).describe("Clinical notes.") }).describe("v");
    expect(masked(Visit, { notes: { text: "x" } })).toEqual({ notes: "[phi]" });
  });

  test("masks a record's values and a tuple's positions", () => {
    const Shape = z
      .object({
        notes: z.record(z.string(), phi(z.string())).describe("Notes."),
        pair: z.tuple([z.string(), secret(z.string())]).describe("A pair."),
      })
      .describe("A shape.");
    expect(masked(Shape, { notes: { a: "x", b: "y" }, pair: ["id", "tok"] })).toEqual({
      notes: { a: "[phi]", b: "[phi]" },
      pair: ["id", "[secret]"],
    });
  });

  test("uses an adopter class's own mask", () => {
    const genetic = definePrivacyClass({ name: "genetic_redact", mask: () => "[genome]" });
    const Sample = z.object({ sequence: genetic(z.string()) }).describe("A sample.");
    expect(masked(Sample, { sequence: "ACGT" })).toEqual({ sequence: "[genome]" });
  });

  test("masks with the class placeholder when the class was never registered", () => {
    const Odd = z.object({ value: z.string().meta({ privacy: "unregistered_redact" }) }).describe("o");
    expect(redact(Odd, { value: "x" })).toEqual({ value: "[unregistered_redact]" });
  });

  test("masks a key an object's catchall marks, and keeps one a loose object lets through", () => {
    const Bag = z.object({ id: z.string() }).catchall(pii(z.string())).describe("A bag.");
    expect(masked(Bag, { id: "1", e: "S-1" })).toEqual({ id: "1", e: "[pii]" });
    const Loose = z.looseObject({ id: z.string() });
    expect(masked(Loose, { id: "u", extra: 1 })).toEqual({ id: "u", extra: 1 });
  });

  test("masks a marked record key, keeping entries apart and never taking a kept key's name", () => {
    const ByEmail = z.object({ m: z.record(pii(z.string()), z.number()) });
    const byEmail = redact(ByEmail, ByEmail.parse({ m: { "S-a": 1, "S-b": 2 } }));
    expect(byEmail).toEqual({ m: { "[pii]": 1, "[pii] #2": 2 } });
    const Rec = z.record(z.union([pii(z.email()), z.string()]), z.string());
    const rec = redact(Rec, { "a@b.co": "v1", "[pii]": "v2" });
    expect(Object.keys(rec)).toHaveLength(2);
    expect(Object.values(rec).sort()).toEqual(["v1", "v2"]);
    expect(JSON.stringify(rec)).not.toContain("@");
  });

  test("keeps an own __proto__ key as an own key", () => {
    const Meta = z.object({ meta: z.unknown() });
    const value = Meta.parse({ meta: JSON.parse('{"__proto__":{"x":1},"a":1}') });
    const out = redact(Meta, value) as { meta: Record<string, unknown> };
    expect(Object.hasOwn(out.meta, "__proto__")).toBe(true);
    expect(Object.getPrototypeOf(out.meta)).toBe(Object.prototype);
    expect(JSON.stringify(out)).toBe(JSON.stringify(value));
    const Keyed = z.record(z.string(), z.number());
    const rec = redact(Keyed, JSON.parse('{"__proto__":1,"b":2}') as Record<string, number>);
    expect(Object.keys(rec)).toEqual(["__proto__", "b"]);
    expect(Object.getPrototypeOf(rec)).toBe(Object.prototype);
  });
});

describe("the rule: structural nodes are walked", () => {
  test("masks a position any union option marks, whichever option the value came from", () => {
    const Contact = z.union([
      z.object({ kind: z.literal("email"), email: pii(z.string()) }),
      z.object({ kind: z.literal("token"), token: secret(z.string()) }),
    ]);
    expect(masked(Contact, { kind: "email", email: "S-1" })).toEqual({ kind: "email", email: "[pii]" });
    // A field only one option marks is masked in every option: the price of never guessing.
    const Either = z.union([z.object({ e: pii(z.email()) }), z.object({ e: z.number() })]);
    expect(masked(Either, { e: 5 })).toEqual({ e: "[pii]" });
    // A marked scalar option applies where the value has its shape: a number here, and never the string.
    const Prim = z.union([z.string(), pii(z.number())]);
    expect(redact(Prim, "plain")).toBe("plain");
    expect(masked(Prim, 5)).toBe("[pii]");
    const Tagged = z.discriminatedUnion("t", [
      z.object({ t: z.literal("a"), e: z.string() }),
      z.object({ t: z.literal("b"), e: pii(z.string()) }),
    ]);
    expect(masked(Tagged, { t: "a", e: "S-1" })).toEqual({ t: "a", e: "[pii]" });
  });

  test("keeps every key the value holds, and keeps one no schema names as it is", () => {
    // A key no option names is kept, beside marked fields or not, and never dropped.
    expect(redact(User, { ...ada, extra: "x" } as typeof ada)).toEqual({
      id: "u_1",
      email: "[pii]",
      diagnosis: "[phi]",
      extra: "x",
    });
    expect(redact(z.object({ id: z.string() }), { id: "u", extra: 1 } as never)).toEqual({ id: "u", extra: 1 });
    // A stripped key never reaches redact at all: parse took it.
    expect(masked(User.pick({ id: true }), ada)).toEqual({ id: "u_1" });
  });

  test("walks both sides of an intersection, at every depth, and keeps what either names", () => {
    const Both = z.intersection(
      z.object({ p: z.object({ name: z.string(), deep: z.object({ a: z.string() }) }) }),
      z.object({ p: z.object({ email: pii(z.string()), deep: z.object({ b: secret(z.string()) }) }) }),
    );
    expect(masked(Both, { p: { name: "Ada", email: "S-1", deep: { a: "x", b: "S-2" } } })).toEqual({
      p: { name: "Ada", email: "[pii]", deep: { a: "x", b: "[secret]" } },
    });
    const Left = z.union([z.object({ b: pii(z.string()), z: z.number() }), z.object({ c: z.string() })]);
    const Right = z.union([z.object({ b: pii(z.string()), z: z.number() }), z.object({ d: z.string() })]);
    expect(redact(z.intersection(Left, Right), { b: "S-1", c: "c", d: "d" } as never)).toEqual({
      b: "[pii]",
      c: "c",
      d: "d",
    });
  });

  test("follows a lazy, so a recursive schema is masked at every depth and the walk ends", () => {
    type Node = { e: string; next?: Node };
    const Nd: z.ZodType<Node> = z.lazy(() => z.object({ e: pii(z.string()), next: Nd.optional() }));
    expect(masked(Nd, { e: "S-1", next: { e: "S-2", next: { e: "S-3" } } })).toEqual({
      e: "[pii]",
      next: { e: "[pii]", next: { e: "[pii]" } },
    });
    expect(classifyPrivacy(Nd)).toEqual([{ path: "e", class: "pii" }]);
    // A lazy that reaches itself at the same position stops there.
    type Tree = string | Tree[];
    const Loop: z.ZodType<Tree> = z.lazy(() => z.union([z.string(), z.array(Loop), Loop]));
    expect(masked(Loop, ["a", ["b"]])).toEqual(["a", ["b"]]);
    // A recursive object written with a getter.
    const Category = z.object({
      label: pii(z.string()),
      get children() {
        return z.array(Category);
      },
    });
    expect(masked(Category, { label: "S-1", children: [{ label: "S-2", children: [] }] })).toEqual({
      label: "[pii]",
      children: [{ label: "[pii]", children: [] }],
    });
    // The type: a self-referencing lazy has to be annotated `z.ZodType<T>`, which names no kind, so it is `unknown`,
    // and so is every field that holds it. The getter is inferred, and keeps its shape.
    type Same<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;
    const same = <A, B>(..._proof: Same<A, B> extends true ? [] : [never]): void => {};
    same<Redacted<typeof Nd>, unknown>();
    same<Redacted<z.ZodObject<{ id: z.ZodNumber; list: typeof Nd }>>, { id: number; list: unknown }>();
    type Walked = Redacted<typeof Category>;
    same<Walked["label"], string>();
    same<Walked["children"][number]["label"], string>();
  });

  test("keeps every element a tuple has no item for", () => {
    expect(masked(z.union([z.tuple([z.string()]), z.any()]), ["a", "b", "c"])).toEqual(["a", "b", "c"]);
    // Handed more than it names, a tuple keeps the extra element, which no item names, rather than dropping it.
    expect(redact(z.tuple([pii(z.string())]), ["S-1", "x"] as never)).toEqual(["[pii]", "x"]);
  });

  test("walks a catch, a default, a readonly and a brand as the field they wrap", () => {
    const Wrapped = z.object({ e: pii(z.string()).brand<"E">(), n: z.string() }).readonly();
    expect(masked(Wrapped, { e: "S-1", n: "n" })).toEqual({ e: "[pii]", n: "n" });
    const Defaulted = z.object({ e: pii(z.string()) }).default({ e: "S-d" } as never);
    expect(masked(Defaulted, undefined)).toEqual({ e: "[pii]" });
    // A constant fallback's field is masked where the object marks it, and its extra key, which no schema names, is
    // kept. A fallback function makes a new value, so it is opaque: see "outside the contract".
    const Caught = z.object({ e: pii(z.string()), n: z.number() }).catch({ e: "S-c", n: 0, extra: "x" } as never);
    expect(masked(Caught, { e: "S-1", n: "bad" })).toEqual({ e: "[pii]", n: 0, extra: "x" });
    const Called = z
      .object({ e: pii(z.string()), n: z.number() })
      .catch((ctx) => ({ e: String((ctx.input as { e: string }).e), n: 0, extra: "x" }) as never);
    expect(masked(Called, { e: "S-1", n: "bad" })).toBe("[pii]");
  });

  test("Redacted<T> types a position unknown where it nests more wrappers and choices than the type follows", () => {
    type Same<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;
    const same = <A, B>(..._proof: Same<A, B> extends true ? [] : [never]): void => {};
    same<REDACT_TYPE_DEPTH, 16>();
    // Sixteen wrappers, the most the type follows: the position keeps its exact type.
    const wrap16 = <T extends z.ZodType>(inner: T) =>
      inner
        .optional()
        .nullable()
        .optional()
        .nullable()
        .optional()
        .nullable()
        .optional()
        .nullable()
        .optional()
        .nullable()
        .optional()
        .nullable()
        .optional()
        .nullable()
        .optional()
        .nullable();
    const Plain16 = z.object({ x: wrap16(z.number()) });
    const Marked16 = z.object({ x: wrap16(pii(z.number())) });
    same<Redacted<typeof Plain16>["x"], number | null | undefined>();
    same<Redacted<typeof Marked16>["x"], string | null | undefined>();
    // Seventeen: past what the type follows, the position is unknown, never a guessed concrete type.
    const Plain17 = z.object({ x: wrap16(z.number()).optional() });
    const Marked17 = z.object({ x: wrap16(pii(z.number())).optional() });
    same<Redacted<typeof Plain17>["x"], unknown>();
    // A marked node is read by the brand its output carries, which no number of wrappers hides: it stays exact.
    same<Redacted<typeof Marked17>["x"], string | null | undefined>();
    // A choice counts as a level too.
    const Chosen17 = z.object({ x: z.union([wrap16(z.number()), z.boolean()]) });
    same<Redacted<typeof Chosen17>["x"], unknown>();
    // The runtime walks any depth of wrapper: the value is what it was, and the type takes it.
    const plain: Redacted<typeof Plain17>["x"] = redact(Plain17, Plain17.parse({ x: 5 })).x;
    expect(plain).toBe(5);
    expect(redact(Marked17, Marked17.parse({ x: 5 })).x).toBe("[pii]");
    expect(redact(Chosen17, Chosen17.parse({ x: true })).x).toBe(true);
  });
});

describe("the contract's edges", () => {
  test("masks a position two classes reach with the stronger one's placeholder, never one class's own mask", () => {
    const Id = z.union([z.object({ n: pci(z.string()) }), z.object({ n: pii(z.string()) })]);
    expect(masked(Id, { n: "4111111111111111" })).toEqual({ n: "[pci]" });
  });

  test("keeps a value of a kind no option names, as a constant fallback hands back, and one a scalar option holds", () => {
    const map = new Map([["email", "x"]]);
    const caught = (fallback: unknown) => z.object({ email: pii(z.string()) }).catch(fallback as never);
    // The object's marks apply to an object value: a string, an array or a map has none of its shape.
    expect(masked(caught("x"), 1)).toBe("x");
    expect(masked(caught(["x"]), 1)).toEqual(["x"]);
    expect(masked(z.object({ u: caught(map) }), { u: 1 })).toEqual({ u: map });
    expect(masked(caught("x"), { email: "S-1" })).toEqual({ email: "[pii]" });
    const at = new Date(0);
    expect(masked(z.union([z.string(), z.object({ e: pii(z.string()) })]), "hello")).toBe("hello");
    expect(masked(z.union([z.date(), z.object({ e: pii(z.string()) })]), at)).toBe(at);
  });

  test("applies a marked scalar option only where the value has its shape, at runtime, in the list and in the type", () => {
    type Same<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;
    const same = <A, B>(..._proof: Same<A, B> extends true ? [] : [never]): void => {};
    // An array option beside a marked string: an array value is walked by the array option, which marks nothing.
    const Either = z.union([pii(z.string()), z.array(z.string())]);
    expect(masked(Either, ["P-1"])).toEqual(["P-1"]);
    expect(masked(Either, "S-1")).toBe("[pii]");
    expect(classifyPrivacy(Either)).toEqual([{ path: "", class: "pii" }]);
    same<Redacted<typeof Either>, string | string[]>();
    // A number beside a marked string, as a field: the number is kept.
    const Field = z.object({ v: z.union([pii(z.string()), z.number()]) });
    expect(masked(Field, { v: 42 })).toEqual({ v: 42 });
    expect(masked(Field, { v: "S-1" })).toEqual({ v: "[pii]" });
    expect(classifyPrivacy(Field)).toEqual([{ path: "v", class: "pii" }]);
    same<Redacted<typeof Field>, { v: string | number }>();
    // A marked object option beside a number masks an object value, and keeps the number.
    const Obj = z.union([pii(z.object({ e: z.string() })), z.number()]);
    expect(masked(Obj, 7)).toBe(7);
    expect(masked(Obj, { e: "S-1" })).toBe("[pii]");
    same<Redacted<typeof Obj>, string | number>();
    // A marked array option beside an object option walks the object and masks the array.
    const Lists = z.union([pii(z.array(z.string())), z.object({ e: pii(z.string()), u: z.string() })]);
    expect(masked(Lists, ["S-1"])).toBe("[pii]");
    expect(masked(Lists, { e: "S-1", u: "P-1" })).toEqual({ e: "[pii]", u: "P-1" });
    expect(classifyPrivacy(Lists)).toEqual([
      { path: "", class: "pii" },
      { path: "e", class: "pii" },
    ]);
    same<Redacted<typeof Lists>, string | { e: string; u: string }>();
    // Outside the contract: an unmarked transform or unknown option beside a marked scalar keeps its value.
    const Doubled = z.union([pii(z.string()), z.number().transform((n) => n * 2)]);
    expect(masked(Doubled, 3)).toBe(6);
    expect(masked(Doubled, "S-1")).toBe("[pii]");
    same<Redacted<typeof Doubled>, string | number>();
    const Loose = z.object({ f: z.union([pii(z.string()), z.unknown()]) });
    expect(masked(Loose, { f: [1, 2] })).toEqual({ f: [1, 2] });
    expect(masked(Loose, { f: "S-1" })).toEqual({ f: "[pii]" });
    // Nested choices narrow each other: the inner string option applies to neither a number nor an array.
    const Nested = z.union([z.union([pii(z.string()), z.boolean()]), z.array(z.number())]);
    expect(masked(Nested, true)).toBe(true);
    expect(masked(Nested, [1])).toEqual([1]);
    expect(masked(Nested, "S-1")).toBe("[pii]");
    same<Redacted<typeof Nested>, string | boolean | number[]>();
    // A literal and an enum have the shape of their values.
    const Literal = z.union([pii(z.literal(1)), z.enum(["a", "b"])]);
    expect(masked(Literal, "a")).toBe("a");
    expect(masked(Literal, 1)).toBe("[pii]");
    same<Redacted<typeof Literal>, string>();
    // A marked date codec applies to a date, never to a string.
    const Dated = z.union([z.string(), pii(SQLiteDate)]);
    expect(masked(Dated, "P-1")).toBe("P-1");
    expect(masked(Dated, 1_000)).toBe("[pii]");
    same<Redacted<typeof Dated>, string>();
  });

  test("masks a record's string keys by every mark but a symbol's, and its symbol keys by a symbol's alone", () => {
    type Same<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;
    const same = <A, B>(..._proof: Same<A, B> extends true ? [] : [never]): void => {};
    const sym = Symbol("k");
    // A symbol key matched only the unmarked `z.symbol()` option: it comes back as it went in.
    const Names = z.record(z.union([pii(z.string()), z.symbol()]), z.string());
    const names = masked(Names, { [sym]: "P-1", "S-1": "P-2" }) as Record<PropertyKey, unknown>;
    expect(Reflect.ownKeys(names)).toEqual(["[pii]", sym]);
    expect(names[sym]).toBe("P-1");
    expect(names["[pii]"]).toBe("P-2");
    same<Redacted<typeof Names>, { [key: string]: string; [key: symbol]: string }>();
    // A marked symbol option masks a symbol key, and leaves a string key alone.
    const Tags = z.record(z.union([z.string(), pii(z.symbol())]), z.string());
    const tags = masked(Tags, { [sym]: "P-1", "P-k": "P-2" }) as Record<PropertyKey, unknown>;
    expect(Reflect.ownKeys(tags)).toEqual(["P-k", "[pii]"]);
    expect(tags["[pii]"]).toBe("P-1");
    same<Redacted<typeof Tags>, { [key: string]: string }>();
    // A number key is a string at runtime, so a marked number option still masks every string key.
    const Numbered = z.record(z.union([pii(z.number()), z.string()]), z.string());
    expect(Reflect.ownKeys(masked(Numbered, { "5": "P-1", "P-k": "P-2" }) as object)).toEqual(["[pii]", "[pii] #2"]);
  });

  test("keeps a string beside a marked option of another shape, however many values that option names", () => {
    // A choice is read for its shapes to the end, never to a count of schemas: nothing here recurses.
    const literals = (n: number) =>
      z.union(
        Array.from({ length: n }, (_, index) => z.literal(index)) as [z.ZodLiteral<number>, z.ZodLiteral<number>],
      );
    for (const n of [9_998, 10_001, 20_000]) {
      const U = z.object({ c: z.union([pii(literals(n)), z.string()]) });
      expect(masked(U, { c: "P-1" })).toEqual({ c: "P-1" });
      expect(masked(U, { c: 7 })).toEqual({ c: "[pii]" });
    }
  });

  test("keeps a record's symbol keys, numbers a set's masked elements apart, and redacts a map's object keys", () => {
    const tag = Symbol("tag");
    expect(masked(z.record(z.symbol(), z.object({ e: pii(z.string()) })), { [tag]: { e: "S-1" } })).toEqual({
      [tag]: { e: "[pii]" },
    });
    const tags = redact(z.set(pii(z.string())), new Set(["S-1", "S-2", "S-3"]) as never);
    expect([...tags]).toEqual(["[pii]", "[pii] #2", "[pii] #3"]);
    // A kept element is never renamed: only a masked one is numbered, past every kept one.
    const Mixed = z.set(z.union([pii(z.number()), z.string()]));
    expect([...redact(Mixed, Mixed.parse(new Set([5, "[pii]"])))]).toEqual(["[pii] #2", "[pii]"]);
    expect([...redact(Mixed, Mixed.parse(new Set([1, 2, "[pii] #2"])))]).toEqual(["[pii]", "[pii] #3", "[pii] #2"]);
    const MixedKeys = z.map(z.union([pii(z.array(z.string())), z.string()]), z.number());
    const keys = redact(
      MixedKeys,
      MixedKeys.parse(
        new Map<unknown, number>([
          [["S-1"], 1],
          ["[pii]", 2],
        ]),
      ),
    );
    expect([...keys]).toEqual([
      ["[pii] #2", 1],
      ["[pii]", 2],
    ]);
    const ByUser = z.map(z.object({ id: z.string(), e: pii(z.string()) }), z.number());
    const byUser = masked(ByUser, new Map([[{ id: "u_1", e: "S-1" }, 1]])) as Map<unknown, number>;
    expect([...byUser]).toEqual([[{ id: "u_1", e: "[pii]" }, 1]]);
  });

  test("walks a linked list and a tree defined once, lists their fields once, and ends", () => {
    const Item = z.object({
      e: pii(z.string()),
      get next() {
        return Item.optional();
      },
    });
    expect(classifyPrivacy(Item)).toEqual([{ path: "e", class: "pii" }]);
    expect(masked(Item, { e: "S-1", next: { e: "S-2", next: { e: "S-3" } } })).toEqual({
      e: "[pii]",
      next: { e: "[pii]", next: { e: "[pii]" } },
    });
    type Tree = { name: string; owner: string; children: Tree[] };
    const Tree: z.ZodType<Tree> = z.lazy(() =>
      z.object({ name: z.string(), owner: phi(z.string()), children: z.array(Tree) }),
    ) as z.ZodType<Tree>;
    const leaf = { name: "leaf", owner: "S-2", children: [] };
    expect(masked(Tree, { name: "root", owner: "S-1", children: [leaf, leaf] })).toEqual({
      name: "root",
      owner: "[phi]",
      children: [
        { name: "leaf", owner: "[phi]", children: [] },
        { name: "leaf", owner: "[phi]", children: [] },
      ],
    });
    expect(classifyPrivacy(Tree)).toEqual([{ path: "owner", class: "phi" }]);
  });

  test("types a union's array by the items a tuple beside it names, and a record by the keys an object names", () => {
    const Pair = z.union([z.tuple([pii(z.string()), z.number()]), z.array(z.number())]);
    const pair: Redacted<typeof Pair> = ["[pii]", 2, 3];
    expect(masked(Pair, [1, 2, 3])).toEqual(pair);
    // @ts-expect-error The array's first element is masked where the tuple marks it, so a number is refused there.
    const wrongPair: Redacted<typeof Pair> = [1, 2, 3];
    expect(masked(Pair, ["S-1", 2])).toEqual(["[pii]", 2]);
    const Bag = z.union([z.object({ a: pii(z.string()), c: z.boolean() }), z.record(z.string(), z.number())]);
    const bag: Redacted<typeof Bag> = { a: "[pii]", b: 2 };
    expect(masked(Bag, { a: 1, b: 2 })).toEqual(bag);
    // @ts-expect-error The record's `a` is masked where the object marks it, so a number is refused there.
    const wrongBag: Redacted<typeof Bag> = { a: 1, b: 2 };
    // And the other way round: an open object's extra key is masked where a record marks every value.
    const Open = z.union([z.object({ a: z.number() }).catchall(z.number()), z.record(z.string(), pii(z.string()))]);
    const open: Redacted<typeof Open> = { a: "[pii]", b: "[pii]" };
    expect(masked(Open, { a: 1, b: 2 })).toEqual(open);
    // A tuple's rest is masked only at the positions a longer tuple beside it marks.
    const Rest = z.union([z.tuple([z.number()], z.number()), z.tuple([z.number(), z.number(), pii(z.string())])]);
    const rest: Redacted<typeof Rest> = [1, 2, "[pii]", 4];
    expect(masked(Rest, [1, 2, 3, 4])).toEqual(rest);
    void [wrongPair, wrongBag];
  });

  test("a getter that builds a new schema each read is walked as the schema Zod settled on, read first or not", () => {
    const shape = () => ({
      id: z.number(),
      get addr() {
        return z.object({ email: pii(z.string()), city: z.string() });
      },
    });
    const value = { id: 1, addr: { email: "S-1", city: "Paris" } };
    // Met by redact before parse ever read it, and met after: the same walk, and the same type.
    const Unread = z.object(shape());
    expect(redact(Unread, value as never)).toEqual({ id: 1, addr: { email: "[pii]", city: "Paris" } });
    const Read = z.object(shape());
    Read.parse(value);
    expect(redact(Read, value as never)).toEqual({ id: 1, addr: { email: "[pii]", city: "Paris" } });
    expect(classifyPrivacy(z.object(shape()))).toEqual([{ path: "addr.email", class: "pii" }]);
    type Same<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;
    const same = <A, B>(..._proof: Same<A, B> extends true ? [] : [never]): void => {};
    same<Redacted<typeof Unread>["addr"], { email: string; city: string }>();
    // A recursion through a getter that builds its record anew: the record settles once, so it is a recursion
    // defined once.
    type Kin = { name: string; email: string; kids: Record<string, Kin> };
    const Kin: z.ZodType<Kin> = z.object({
      name: z.string(),
      email: pii(z.string()),
      get kids() {
        return z.record(z.string(), Kin);
      },
    });
    const kin = { name: "a", email: "S-1", kids: { b: { name: "b", email: "S-2", kids: {} } } };
    expect(redact(Kin, kin)).toEqual({
      name: "a",
      email: "[pii]",
      kids: { b: { name: "b", email: "[pii]", kids: {} } },
    });
    expect(classifyPrivacy(Kin)).toEqual([{ path: "email", class: "pii" }]);
  });

  test("types a marked JSON column as a string, though an option inside it carries the same mark", () => {
    type Same<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;
    const same = <A, B>(..._proof: Same<A, B> extends true ? [] : [never]): void => {};
    const Row = z.object({ col: pii(sqliteJson(z.union([pii(z.boolean()), z.array(z.number())]))) });
    expect(masked(Row, { col: "[1,2]" })).toEqual({ col: "[pii]" });
    expect(classifyPrivacy(Row)).toEqual([{ path: "col", class: "pii" }]);
    same<Redacted<typeof Row>, { col: string }>();
    const Scalar = z.object({ col: pii(sqliteJson(z.union([pii(z.string()), z.number()]))) });
    expect(masked(Scalar, { col: "7" })).toEqual({ col: "[pii]" });
    same<Redacted<typeof Scalar>, { col: string }>();
    // A pipe whose every output already carries the mark it pipes into is still the opaque node it was.
    const Piped = z.object({ p: z.string().pipe(secret(z.string())) });
    same<Redacted<typeof Piped>, { p: unknown }>();
  });

  test("types a record keyed by a marked enum or literal as one with string keys and its values kept", () => {
    type Same<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;
    const same = <A, B>(..._proof: Same<A, B> extends true ? [] : [never]): void => {};
    const Tally = z.record(pii(z.enum(["US", "CA"])), z.number());
    expect(masked(Tally, { US: 1, CA: 2 })).toEqual({ "[pii]": 1, "[pii] #2": 2 });
    same<Redacted<typeof Tally>, { [key: string]: number }>();
    const One = z.record(pii(z.literal("a")), z.number());
    expect(masked(One, { a: 1 })).toEqual({ "[pii]": 1 });
    same<Redacted<typeof One>, { [key: string]: number }>();
    const Nested = z.object({ tally: Tally });
    same<Redacted<typeof Nested>, { tally: { [key: string]: number } }>();
    // An unmarked enum key keeps its keys.
    const Plain = z.record(z.enum(["US", "CA"]), z.number());
    same<Redacted<typeof Plain>, { US: number; CA: number }>();
  });

  test("types a field one object marks as a string, though a loose object sits beside it", () => {
    type Same<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;
    const same = <A, B>(..._proof: Same<A, B> extends true ? [] : [never]): void => {};
    const Both = z.intersection(z.object({ a: pii(z.string()) }), z.looseObject({}));
    expect(masked(Both, { a: "S-1", z: 1 })).toEqual({ a: "[pii]", z: 1 });
    same<Redacted<typeof Both>["a"], string>();
    const Either = z.union([z.object({ a: pii(z.string()) }), z.looseObject({})]);
    expect(masked(Either, { a: "S-1" })).toEqual({ a: "[pii]" });
    same<Extract<Redacted<typeof Either>, { a: unknown }>["a"], string>();
  });
});

describe("outside the contract: masked whole when marked beneath, kept when not, never throws, never raw", () => {
  test("a transform, a preprocess and a pipe are masked whole over a mark, and kept over none", () => {
    const Copy = z.object({ e: pii(z.string()), n: z.string() }).transform((v) => ({ copy: v.e, n: v.n }));
    expect(masked(Copy, { e: "S-1", n: "n" })).toBe("[pii]");
    expect(classifyPrivacy(Copy)).toEqual([{ path: "", class: "pii" }]);
    const Pre = z.preprocess((v) => v, z.object({ e: phi(z.string()) }));
    expect(masked(Pre, { e: "S-1" })).toBe("[phi]");
    const Piped = z.string().pipe(secret(z.string()));
    expect(masked(z.object({ p: Piped }), { p: "S-1" })).toEqual({ p: "[secret]" });
    const Length = z.object({ n: z.string().transform((s) => s.length) });
    expect(masked(Length, { n: "four" })).toEqual({ n: 4 });
    // A transform on an intersection's side with nothing marked beneath it is kept as it is: its key is one no
    // schema names, and the side that marks `e` applies only to `e`.
    const Side = z.intersection(
      z.object({ e: pii(z.string()) }),
      z.object({ e: z.string() }).transform((v) => ({ copied: v.e.length })),
    );
    expect(masked(Side, { e: "S-1" })).toEqual({ e: "[pii]", copied: 3 });
  });

  test("an adopter's codec is masked whole over a mark, and kept over none", () => {
    const Marked = z.codec(z.string(), z.object({ e: pii(z.string()) }), {
      decode: (text) => JSON.parse(text),
      encode: (value) => JSON.stringify(value),
    });
    expect(masked(z.object({ c: Marked }), { c: '{"e":"S-1"}' })).toEqual({ c: "[pii]" });
    expect(classifyPrivacy(z.object({ c: Marked }))).toEqual([{ path: "c", class: "pii" }]);
    const Plain = z.codec(z.string(), z.object({ city: z.string() }), {
      decode: (text) => JSON.parse(text),
      encode: (value) => JSON.stringify(value),
    });
    expect(masked(z.object({ c: Plain }), { c: '{"city":"Oslo"}' })).toEqual({ c: { city: "Oslo" } });
    // One built the way the kit builds a JSON column is still not the kit's: masked whole, and typed unknown.
    const Inner = z.object({ email: pii(z.string()), city: z.string() });
    const MyJson = z.codec(z.union([z.string(), Inner]), Inner, {
      decode: (v) => (typeof v === "string" ? JSON.parse(v) : v),
      encode: (v) => JSON.stringify(v),
    });
    expect(masked(MyJson, '{"email":"S-1","city":"Oslo"}')).toBe("[pii]");
    type Same<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;
    const same = <A, B>(..._proof: Same<A, B> extends true ? [] : [never]): void => {};
    same<Redacted<typeof MyJson>, unknown>();
    // The kit's own, and a clone of it, are walked field by field, at runtime and in the type.
    const Column = sqliteJson(Inner).describe("A JSON column.");
    expect(masked(Column, '{"email":"S-1","city":"Oslo"}')).toEqual({ email: "[pii]", city: "Oslo" });
    same<Redacted<typeof Column>, { email: string; city: string }>();
  });

  test("a z.custom, an any and an unknown are kept as they are, and masked where marked", () => {
    class Acct {
      constructor(readonly email: string) {}
    }
    const acct = new Acct("S-1");
    const Custom = z.object({ a: z.custom<Acct>((v) => v instanceof Acct), b: z.any(), c: z.unknown() });
    const value = { a: acct, b: { x: 1 }, c: [1] };
    const out = redact(Custom, value) as typeof value;
    expect(out.a).toBe(acct);
    expect(out.b).toBe(value.b);
    expect(out.c).toBe(value.c);
    expect(masked(z.object({ a: pii(z.custom<Acct>((v) => v instanceof Acct)) }), { a: acct })).toEqual({
      a: "[pii]",
    });
  });

  test("an opaque option with nothing marked beneath it keeps its value beside a marked option", () => {
    const Obj = z.object({ e: pii(z.string()) });
    const listed = [{ path: "e", class: "pii" }];
    const opaque: [string, z.ZodType][] = [
      ["unknown", z.unknown()],
      ["any", z.any()],
      ["custom", z.custom<unknown>(() => true)],
    ];
    for (const [, other] of opaque) {
      const Either = z.union([Obj, other]);
      // The object option's marks apply to an object value, by the keys it names; a key it does not name is kept.
      expect(masked(Either, { zzz: "P-1" })).toEqual({ zzz: "P-1" });
      const both = redact(Either, { e: "S-1", zzz: "P-1" } as never);
      expect(both).toEqual({ e: "[pii]", zzz: "P-1" });
      expect(raw(both)).toEqual([]);
      // An array, a string, a map: no option of that shape marks anything, so each is kept as it is.
      expect(masked(Either, ["P-1", "P-2"])).toEqual(["P-1", "P-2"]);
      expect(masked(Either, "P-1")).toBe("P-1");
      const map = new Map([["e", "P-1"]]);
      expect(masked(Either, map)).toBe(map);
      expect(classifyPrivacy(Either)).toEqual(listed);
      // As a row's field, the same.
      const Row = z.object({ id: z.string(), f: Either });
      expect(masked(Row, { id: "P-0", f: { zzz: "P-1" } })).toEqual({ id: "P-0", f: { zzz: "P-1" } });
      expect(masked(Row, { id: "P-0", f: { e: "S-1" } })).toEqual({ id: "P-0", f: { e: "[pii]" } });
    }
    // A transform option's output, an object or an array, is its own: nothing beneath it is marked.
    const ToObject = z.union([Obj, z.string().transform((text) => ({ zzz: text }))]);
    expect(masked(ToObject, "P-1")).toEqual({ zzz: "P-1" });
    expect(masked(ToObject, { e: "S-1" })).toEqual({ e: "[pii]" });
    const ToArray = z.union([Obj, z.string().transform((text) => [text])]);
    expect(masked(ToArray, "P-1")).toEqual(["P-1"]);
    // An array option's marks apply to an array value, and never to an object one.
    const Lists = z.union([z.array(pii(z.string())), z.unknown()]);
    expect(masked(Lists, ["S-1"])).toEqual(["[pii]"]);
    expect(masked(Lists, { 0: "P-1" })).toEqual({ 0: "P-1" });
    // The type is each option's own: the object's field is masked, and the opaque option keeps its output.
    type Same<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;
    const same = <A, B>(..._proof: Same<A, B> extends true ? [] : [never]): void => {};
    same<Redacted<typeof ToObject>, { e: string } | { zzz: string }>();
    same<Redacted<typeof ToArray>, { e: string } | string[]>();
    same<Redacted<z.ZodUnion<[typeof Obj, z.ZodCustom<Date>]>>, { e: string } | Date>();
  });

  test("an .overwrite() and a .catch() fallback function make a new value: masked whole over a mark", () => {
    const Moved = z.object({ e: pii(z.string()), n: z.string() }).overwrite((o) => ({ ...o, n: o.e }));
    expect(masked(Moved, { e: "S-1", n: "u" })).toBe("[pii]");
    expect(classifyPrivacy(Moved)).toEqual([{ path: "", class: "pii" }]);
    const Copied = z
      .object({ e: pii(z.string()), n: z.number() })
      .catch((ctx) => ({ e: "x", n: 0, copy: (ctx.input as { e: string }).e }) as never);
    expect(masked(Copied, { e: "S-1", n: "bad" })).toBe("[pii]");
    expect(masked(z.object({ id: z.string(), c: Copied.optional() }), { id: "1", c: { e: "S-1", n: 2 } })).toEqual({
      id: "1",
      c: "[pii]",
    });
    // Over a union, an array and a record the same, in the inventory too.
    const Listed = z.array(z.object({ e: phi(z.string()) })).overwrite((rows) => rows);
    expect(masked(Listed, [{ e: "S-1" }])).toBe("[phi]");
    expect(hasPrivacy(z.object({ rows: Listed }), "phi")).toBe(true);
    // Over nothing marked, kept as it is.
    const Plain = z.object({ n: z.string() }).overwrite((o) => ({ ...o, n: o.n.toUpperCase() }));
    expect(masked(Plain, { n: "u" })).toEqual({ n: "U" });
    expect(
      masked(
        z.object({ n: z.string() }).catch(() => ({ n: "f" })),
        1,
      ),
    ).toEqual({ n: "f" });
  });

  test("a scalar's .overwrite() and fallback function change nothing: its own mask, or kept", () => {
    const Card = z.object({ c: pci(z.string()).trim(), n: z.string().toLowerCase(), f: z.string().catch(() => "f") });
    const out = masked(Card, { c: " 4111111111111111 ", n: "U", f: 1 });
    expect(out).toEqual({ c: redact(pci(z.string()), "4111111111111111" as never), n: "u", f: "f" });
    expect(masked(z.object({ c: pci(z.string()).catch(() => "4111111111111111" as never) }), { c: 1 })).toEqual({
      c: redact(pci(z.string()), "4111111111111111" as never),
    });
  });

  test("Redacted<T> types a .catch() over a structure with a mark beneath unknown, a constant one included", () => {
    type Same<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;
    const same = <A, B>(..._proof: Same<A, B> extends true ? [] : [never]): void => {};
    const Inner = z.object({ e: pii(z.string()), n: z.number() });
    const Shape = z.object({
      called: Inner.catch(() => ({ e: "x", n: 0 }) as never),
      constant: Inner.catch({ e: "x", n: 0 } as never),
      plain: z.object({ n: z.number() }).catch({ n: 0 }),
      scalar: pii(z.string()).catch("x" as never),
      kept: z.number().catch(0),
    });
    type Out = Redacted<typeof Shape>;
    // The type cannot tell a constant fallback from a function, so it never guesses which.
    same<Out["called"], unknown>();
    same<Out["constant"], unknown>();
    same<Out["plain"], { n: number }>();
    same<Out["scalar"], string>();
    same<Out["kept"], number>();
    expect(masked(Shape, { called: 1, constant: 1, plain: 1, scalar: 1, kept: "x" })).toEqual({
      called: "[pii]",
      constant: { e: "[pii]", n: 0 },
      plain: { n: 0 },
      scalar: "[pii]",
      kept: 0,
    });
  });

  test("Redacted<T> types an opaque position unknown where it is marked beneath, and as its output where not", () => {
    type Same<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;
    const same = <A, B>(..._proof: Same<A, B> extends true ? [] : [never]): void => {};
    const Shape = z.object({
      copy: z.object({ e: pii(z.string()) }).transform((v) => ({ copy: v.e })),
      length: z.string().transform((s) => s.length),
      any: z.any(),
      unknown: z.unknown(),
      custom: z.custom<Date>(),
    });
    type Out = Redacted<typeof Shape>;
    same<Out["copy"], unknown>();
    same<Out["length"], number>();
    same<Out["any"], unknown>();
    same<Out["unknown"], unknown>();
    same<Out["custom"], Date>();
    expect(true).toBe(true);
  });

  test("Redacted<T> types a pipe into a marked schema unknown, as redact masks it whole", () => {
    type Same<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;
    const same = <A, B>(..._proof: Same<A, B> extends true ? [] : [never]): void => {};
    const Inner = z.object({ m: pii(z.string()) });
    const Shape = z.object({
      email: z.email().pipe(pii(z.string())),
      twice: z.string().pipe(z.string()).pipe(pii(z.string())),
      mapped: z
        .string()
        .transform((s) => s)
        .pipe(pii(z.string())),
      picked: Inner.transform((v) => v.m),
      // A marker on the pipe itself is the pipe's own mark: a marked node, typed `string`.
      own: pii(z.email().pipe(z.string())),
      other: phi(z.string().pipe(pii(z.string()))),
    });
    const wire = { email: "a@b.co", twice: "S-1", mapped: "S-2", picked: { m: "S-3" }, own: "c@d.co", other: "S-4" };
    const out = redact(Shape, Shape.parse(wire));
    expect(out).toEqual({
      email: "[pii]",
      twice: "[pii]",
      mapped: "[pii]",
      picked: "[pii]",
      own: "[pii]",
      other: "[phi]",
    });
    type Out = Redacted<typeof Shape>;
    same<Out["email"], unknown>();
    same<Out["twice"], unknown>();
    same<Out["mapped"], unknown>();
    same<Out["picked"], unknown>();
    same<Out["own"], string>();
    same<Out["other"], string>();
  });

  test("Redacted<T> types a record keyed by a pipe into a marked schema by plain string keys, as redact masks them", () => {
    type Same<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;
    const same = <A, B>(..._proof: Same<A, B> extends true ? [] : [never]): void => {};
    const Shape = z.object({
      byEmail: z.record(z.email().pipe(pii(z.string())), z.number()),
      // A union option that is such a pipe masks every key, a symbol's included: it names no single shape.
      either: z.record(z.union([z.email().pipe(pii(z.string())), z.symbol()]), z.number()),
      // A pipe with nothing marked beneath it keeps its keys and their type.
      plain: z.record(z.email().pipe(z.string()), z.number()),
    });
    const tag = Symbol("tag");
    const out = redact(
      Shape,
      Shape.parse({ byEmail: { "a@b.co": 1, "c@d.co": 2 }, either: { "e@f.co": 3, [tag]: 4 }, plain: { "g@h.co": 5 } }),
    );
    expect(out).toEqual({
      byEmail: { "[pii]": 1, "[pii] #2": 2 },
      either: { "[pii]": 3, "[pii] #2": 4 },
      plain: { "g@h.co": 5 },
    });
    expect(Object.getOwnPropertySymbols(out.either)).toEqual([]);
    type Out = Redacted<typeof Shape>;
    same<Out["byEmail"], Record<string, number>>();
    same<Out["either"], Record<string, number>>();
    same<Out["plain"], Record<string, number>>();
    const runtimeShape: Out["byEmail"] = { "[pii]": 1 };
    const unbranded: ContainsMarked<Out> = false;
    expect([runtimeShape, unbranded]).toEqual([{ "[pii]": 1 }, false]);
  });
});

describe("outside the contract, and tested for exactly what it does: five constructions nothing written to it uses", () => {
  test("a symbol key in an object shape is not listed, and not searched beneath an opaque node or a mark", () => {
    const diagnosis = Symbol("diagnosis");
    const Inner = z.object({ id: z.string(), [diagnosis]: phi(z.string()) } as never) as z.ZodType;
    const wire = { id: "1", [diagnosis]: "S-1" };
    // Walked in a row, it is masked, but neither list sees it.
    const Row = z.object({ v: Inner });
    expect((redact(Row, Row.parse({ v: wire }) as never) as { v: Record<symbol, unknown> }).v[diagnosis]).toBe("[phi]");
    expect(classifyPrivacy(Row)).toEqual([]);
    expect(hasPrivacy(Row, "phi")).toBe(false);
    // Beneath a transform it is no mark at all, so the value is kept as it is.
    const Opaque = z.object({ v: Inner.transform((value) => value) });
    expect((redact(Opaque, Opaque.parse({ v: wire }) as never) as { v: Record<symbol, unknown> }).v[diagnosis]).toBe(
      "S-1",
    );
    expect(classifyPrivacy(Opaque)).toEqual([]);
    // Beneath a mark, the container is masked with its own class alone.
    const Marked = z.object({ v: pii(Inner) });
    expect(redact(Marked, Marked.parse({ v: wire }) as never)).toEqual({ v: "[pii]" });
    expect(classifyPrivacy(Marked)).toEqual([{ path: "v", class: "pii" }]);
  });

  test("an object that is not a plain object, where an object with a mark beneath is expected, is masked whole", () => {
    class UserRow {
      id = "user-1";
      email = "S-1@example.com";
    }
    const User = z.object({ id: z.string(), email: pii(z.string()) });
    const row = new UserRow() as unknown as z.output<typeof User>;
    expect(redact(User, row)).toBe("[pii]");
    expect(redact(z.array(User), [row])).toEqual(["[pii]"]);
    expect(redact(z.object({ owner: User }), { owner: row })).toEqual({ owner: "[pii]" });
    const prototyped = Object.assign(Object.create({ kind: "x" }), { id: "user-1", email: "S-1" });
    expect(redact(User, prototyped as never)).toBe("[pii]");
    // The strongest class beneath it is the mask.
    const Both = z.object({ email: pii(z.string()), token: secret(z.string()) });
    expect(redact(Both, new UserRow() as never)).toBe("[secret]");
    // Beside an object option too, construction 2 included.
    class Patient {
      e = "S-1";
      n = "u";
    }
    const patient = new Patient();
    for (const first of [z.any(), z.unknown(), z.instanceof(Patient)]) {
      const Choice = z.union([first, z.object({ e: pii(z.string()), n: z.string() })]);
      expect(redact(Choice, Choice.parse(patient) as never)).toBe("[pii]");
      expect(classifyPrivacy(Choice)).toEqual([{ path: "e", class: "pii" }]);
    }
    const Either = z.union([z.object({ e: pii(z.number()) }), z.any()]);
    expect(redact(Either, Either.parse(Object.create({}, { e: { value: "S-1", enumerable: true } })) as never)).toBe(
      "[pii]",
    );
    // A plain object beside it is walked.
    const Plain = z.union([z.any(), z.object({ e: pii(z.string()), n: z.string() })]);
    expect(masked(Plain, { e: "S-1", n: "u" })).toEqual({ e: "[pii]", n: "u" });
  });

  test("an object that is not a plain object, where an object with no mark beneath is expected, is kept as it is", () => {
    class Note {
      body = "keep me";
    }
    const note = new Note();
    const Unmarked = z.object({ body: z.string() });
    expect(redact(Unmarked, note as never)).toBe(note);
    expect(redact(z.union([z.any(), Unmarked]), note as never)).toBe(note);
    // Beside a marked scalar option, an object option with no mark beneath keeps it too.
    expect(redact(z.union([pii(z.string()), Unmarked]), note as never)).toBe(note);
    // A Date, an array, a Map and a Set are not objects of that kind, and are read as they always were.
    const when = new Date(0);
    expect(redact(z.union([z.date(), z.object({ e: pii(z.string()) })]), when as never)).toBe(when);
  });

  test("a scalar option's .overwrite() or .catch() fallback that makes an object or an array is read by the scalar's kind", () => {
    const Overwritten = z.object({
      e: z.union([pii(z.string()).overwrite((value) => ({ was: value }) as never), z.number()]),
    });
    expect(masked(Overwritten, { e: "S-1" })).toEqual({ e: { was: "S-1" } });
    const Listed = z.object({ e: z.union([pii(z.string().overwrite((value) => [value] as never)), z.number()]) });
    expect(masked(Listed, { e: "S-1" })).toEqual({ e: ["S-1"] });
    const Caught = z.object({ e: z.union([phi(z.string()).catch((ctx) => ctx.input as never), z.boolean()]) });
    expect(masked(Caught, { e: { dx: "S-1" } })).toEqual({ e: { dx: "S-1" } });
    expect(classifyPrivacy(Caught)).toEqual([{ path: "e", class: "phi" }]);
    // A string it makes is the scalar's kind, and masked.
    expect(
      masked(z.object({ e: pii(z.string()).overwrite((value) => value.trim() as never) }), { e: " S-1 " }),
    ).toEqual({
      e: "[pii]",
    });
  });

  test("an array, a Map or a Set passed through as it is is copied without its other own properties", () => {
    const array = Object.assign(["S-1"], { note: "u" });
    const map = Object.assign(new Map([["k", "S-1"]]), { note: "u" });
    const set = Object.assign(new Set(["S-1"]), { note: "u" });
    const cases: [z.ZodType, object, unknown][] = [
      [z.union([z.any(), z.array(pii(z.string()))]), array, ["[pii]"]],
      [z.union([z.any(), z.map(z.string(), pii(z.string()))]), map, new Map([["k", "[pii]"]])],
      [z.union([z.any(), z.set(pii(z.string()))]), set, new Set(["[pii]"])],
    ];
    for (const [schema, value, expected] of cases) {
      const out = redact(schema, schema.parse(value) as never) as Record<string, unknown>;
      expect(out).toEqual(expected);
      expect(out.note).toBeUndefined();
    }
    // A plain object passed through as it is keeps every enumerable own property.
    const Plain = z.union([z.any(), z.object({ e: pii(z.string()) })]);
    expect(masked(Plain, { e: "S-1", note: "u" })).toEqual({ e: "[pii]", note: "u" });
  });
});

describe("a field marked twice", () => {
  type Same<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;
  const same = <A, B>(..._proof: Same<A, B> extends true ? [] : [never]): void => {};

  test("carries both classes: masked with the strongest, and listed with every one", () => {
    const Row = z.object({
      id: z.string(),
      token: pii(secret(z.string())),
      dx: pii(phi(z.string())),
      box: pii(phi(z.object({ a: z.string() }))),
    });
    expect(masked(Row, { id: "u1", token: "S-1", dx: "S-2", box: { a: "S-3" } })).toEqual({
      id: "u1",
      token: "[secret]",
      dx: "[phi]",
      box: "[phi]",
    });
    const listed = classifyPrivacy(Row);
    expect(listed).toEqual(
      expect.arrayContaining([
        { path: "token", class: "secret" },
        { path: "token", class: "pii" },
        { path: "dx", class: "phi" },
        { path: "dx", class: "pii" },
        { path: "box", class: "phi" },
        { path: "box", class: "pii" },
      ]),
    );
    expect(listed).toHaveLength(6);
    expect(hasPrivacy(Row, "secret")).toBe(true);
    expect(hasPrivacy(Row, "phi")).toBe(true);
    same<Redacted<typeof Row>, { id: string; token: string; dx: string; box: string }>();
  });

  test("is the same in either order, through wrappers, and the same class twice is one", () => {
    const shapes = {
      outer: z.object({ v: pii(secret(z.string())) }),
      inner: z.object({ v: secret(pii(z.string())) }),
      wrapped: z.object({ v: pii(secret(z.string()).optional()) }),
      wrappedOutside: z.object({ v: pii(secret(z.string())).optional().nullable() }),
      wrappedInside: z.object({ v: secret(pii(z.string().optional()).nullable()) }),
    };
    for (const Row of Object.values(shapes)) {
      expect(masked(Row, { v: "S-1" })).toEqual({ v: "[secret]" });
      expect([...classifyPrivacy(Row)].sort((a, b) => a.class.localeCompare(b.class))).toEqual([
        { path: "v", class: "pii" },
        { path: "v", class: "secret" },
      ]);
    }
    expect(classifyPrivacy(shapes.outer)).toEqual(classifyPrivacy(shapes.inner));
    const Twice = z.object({ v: pii(pii(z.string())) });
    expect(masked(Twice, { v: "S-1" })).toEqual({ v: "[pii]" });
    expect(classifyPrivacy(Twice)).toEqual([{ path: "v", class: "pii" }]);
  });

  test("takes the strongest placeholder, never one class's own mask: a card marked pii too is [pci]", () => {
    const Card = z.object({ pan: pii(pci(z.string())) });
    expect(masked(Card, { pan: "4242424242424242" })).toEqual({ pan: "[pci]" });
    expect(masked(z.object({ pan: pci(pci(z.string())) }), { pan: "4242424242424242" })).toEqual({
      pan: "424242******4242",
    });
  });

  test("carries an adopter's class the same way, in either order", () => {
    const genetic = definePrivacyClass({ name: "genetic_redact_twice", mask: () => "[genome]" });
    for (const Row of [z.object({ s: pii(genetic(z.string())) }), z.object({ s: genetic(pii(z.string())) })]) {
      expect(masked(Row, { s: "S-1" })).toEqual({ s: "[genetic_redact_twice]" });
      expect(hasPrivacy(Row, "genetic_redact_twice")).toBe(true);
      expect(hasPrivacy(Row, "pii")).toBe(true);
    }
    const Once = z.object({ s: genetic(genetic(z.string())) });
    expect(masked(Once, { s: "S-1" })).toEqual({ s: "[genome]" });
  });
});

describe("an intersection with a record side", () => {
  type Same<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;
  const same = <A, B>(..._proof: Same<A, B> extends true ? [] : [never]): void => {};
  const Keyed = z.record(pii(z.string()), z.union([z.string(), z.number()]));

  test("is typed unknown in either order, as a record's masked keys rename the other side's too", () => {
    const Row = z.intersection(z.object({ k: z.number() }), Keyed);
    const Rev = z.intersection(Keyed, z.object({ k: z.number() }));
    const Loose = z.intersection(z.looseObject({ k: z.number() }), Keyed);
    const Two = z.intersection(Keyed, z.record(z.string(), z.union([z.number(), z.string()])));
    for (const Schema of [Row, Rev, Loose, Two]) {
      const out = masked(Schema, { k: 5, a: "S-1" }) as Record<string, unknown>;
      expect(Object.values(out).sort()).toEqual([5, "S-1"].sort());
      expect(Object.keys(out).sort()).toEqual(["[pii]", "[pii] #2"]);
    }
    same<Redacted<typeof Row>, unknown>();
    same<Redacted<typeof Rev>, unknown>();
    same<Redacted<typeof Loose>, unknown>();
    same<Redacted<typeof Two>, unknown>();
    // Through a wrapper and in a field, the position is unknown and nothing around it changes.
    const Held = z.object({ id: z.string(), tally: Row.optional() });
    same<Redacted<typeof Held>, { id: string; tally?: unknown }>();
  });

  test("is typed unknown with an unmarked record too: one rule, never a narrower type", () => {
    const Plain = z.intersection(z.object({ k: z.number() }), z.record(z.string(), z.number()));
    expect(masked(Plain, { k: 5, a: 1 })).toEqual({ k: 5, a: 1 });
    same<Redacted<typeof Plain>, unknown>();
  });
});

describe("a value read as it was handed back", () => {
  // `z.any()` beside an object option hands back the value it was given, accessors and traps included.
  const Loose = z.union([z.object({ e: pii(z.string()) }), z.any()]);
  const Held = z.object({ id: z.string(), v: Loose });
  const boom = (): never => {
    throw new Error("read");
  };

  test("never throws: a read that throws is [truncated] there, and the walk goes on", () => {
    const getter = { k: "u", e: "S-1" };
    Object.defineProperty(getter, "x", { get: boom, enumerable: true });
    expect(redact(Loose, getter as never)).toEqual({ k: "u", e: "[pii]", x: "[truncated]" });
    expect(redact(Held, { id: "1", v: getter } as never)).toEqual({
      id: "1",
      v: { k: "u", e: "[pii]", x: "[truncated]" },
    });
    const keys = new Proxy({}, { ownKeys: boom });
    expect(redact(Loose, keys as never)).toBe("[truncated]");
    expect(redact(Held, { id: "1", v: keys } as never)).toEqual({ id: "1", v: "[truncated]" });
    const get = new Proxy({ k: "u" }, { get: boom });
    expect(redact(Held, { id: "1", v: get } as never)).toEqual({ id: "1", v: { k: "[truncated]" } });
    const described = new Proxy({ k: "u" }, { getOwnPropertyDescriptor: boom });
    expect(redact(Held, { id: "1", v: described } as never)).toEqual({ id: "1", v: { k: "[truncated]" } });
    const prototype = new Proxy({}, { getPrototypeOf: boom });
    expect(redact(Held, { id: "1", v: prototype } as never)).toEqual({ id: "1", v: "[truncated]" });
    const revocable = Proxy.revocable([], {});
    revocable.revoke();
    expect(redact(Held, { id: "1", v: revocable.proxy } as never)).toEqual({ id: "1", v: "[truncated]" });
  });

  test("never throws on an array, a map or a set whose reads throw", () => {
    const Rows = z.union([z.array(z.object({ e: pii(z.string()) })), z.any()]);
    const rows: unknown[] = [{ e: "S-1" }];
    Object.defineProperty(rows, 1, { get: boom, enumerable: true });
    expect(redact(Rows, rows as never)).toEqual([{ e: "[pii]" }, "[truncated]"]);
    expect(redact(z.object({ r: Rows }), { r: new Proxy([], { get: boom }) } as never)).toEqual({
      r: "[truncated]",
    });
    const map = new Map([["a", "S-1"]]);
    Object.defineProperty(map, Symbol.iterator, { value: boom });
    const ByKey = z.union([z.any(), z.map(z.string(), pii(z.string()))]);
    expect(redact(ByKey, map as never)).toBe("[truncated]");
    expect(redact(z.object({ m: ByKey }), { m: map } as never)).toEqual({ m: "[truncated]" });
    const set = new Set(["S-1"]);
    Object.defineProperty(set, Symbol.iterator, { value: boom });
    const Tags = z.union([z.any(), z.set(pii(z.string()))]);
    expect(redact(Tags, set as never)).toBe("[truncated]");
    expect(redact(z.object({ s: Tags }), { s: set } as never)).toEqual({ s: "[truncated]" });
  });

  test("never throws on a mask that throws: the class's placeholder stands", () => {
    const brittle = definePrivacyClass({ name: "brittle_mask_test", mask: boom });
    expect(redact(z.object({ b: brittle(z.string()) }), { b: "S-1" } as never)).toEqual({ b: "[brittle_mask_test]" });
  });

  test("copies only the enumerable own keys of a value handed back as it is", () => {
    const value = Object.defineProperty({ k: "u" }, "hidden", { value: "u-hidden", enumerable: false });
    const parsed = Loose.parse(value);
    expect(Object.getOwnPropertyNames(parsed)).toEqual(["k", "hidden"]);
    expect(Object.getOwnPropertyNames(redact(Loose, parsed as never))).toEqual(["k"]);
  });
});

describe("a mark on a whole object", () => {
  type Same<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;
  const same = <A, B>(..._proof: Same<A, B> extends true ? [] : [never]): void => {};
  const Marked = pii(z.object({ a: z.string(), b: z.string() }));

  test("does not survive a Zod object method, which builds a fresh schema: mark after deriving", () => {
    const derived: z.ZodType[] = [
      Marked.extend({ c: z.string() }),
      Marked.safeExtend({ c: z.string() }),
      Marked.merge(z.object({ c: z.string() })),
      Marked.pick({ a: true }),
      Marked.omit({ a: true }),
      Marked.partial(),
      Marked.partial().required(),
      Marked.strict(),
      Marked.catchall(z.string()),
    ];
    for (const schema of derived) {
      expect(classifyPrivacy(schema)).toEqual([]);
      expect(classifyPrivacy(pii(schema))).toEqual([{ path: "", class: "pii" }]);
    }
    const Extended = Marked.extend({ c: z.string() });
    same<z.output<typeof Extended>, { a: string; b: string; c: string }>();
    same<Redacted<typeof Extended>, { a: string; b: string; c: string }>();
    expect(masked(pii(Extended), { a: "S-1", b: "S-2", c: "S-3" })).toBe("[pii]");
  });

  test("keeps a field marked inside through every one of them", () => {
    const Inner = z.object({ a: pii(z.string()), b: z.string() });
    expect(classifyPrivacy(Inner.extend({ c: z.string() }))).toEqual([{ path: "a", class: "pii" }]);
    expect(classifyPrivacy(Inner.pick({ a: true }))).toEqual([{ path: "a", class: "pii" }]);
    expect(classifyPrivacy(Inner.partial())).toEqual([{ path: "a", class: "pii" }]);
    expect(masked(Inner.strict(), { a: "S-1", b: "u" })).toEqual({ a: "[pii]", b: "u" });
  });
});

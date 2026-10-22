// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { describe, expect, test } from "vitest";
import { z } from "zod";
import { SQLiteBoolean, SQLiteDate, sqliteJson } from "../data/codecs";
import { LogRecord, serializeRecord } from "../logger/record";
import { definePrivacyClass, pci, phi, pii, secret } from "./classes";
import { classifyPrivacy } from "./classify";
import { redact } from "./redact";
import type { Redacted } from "./types";

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
    // A fallback's field is masked where the object marks it, and its extra key, which no schema names, is kept.
    const Caught = z
      .object({ e: pii(z.string()), n: z.number() })
      .catch((ctx) => ({ e: String((ctx.input as { e: string }).e), n: 0, extra: "x" }) as never);
    expect(masked(Caught, { e: "S-1", n: "bad" })).toEqual({ e: "[pii]", n: 0, extra: "x" });
  });
});

describe("the contract's edges", () => {
  test("masks a position two classes reach with the stronger one's placeholder, never one class's own mask", () => {
    const Id = z.union([z.object({ n: pci(z.string()) }), z.object({ n: pii(z.string()) })]);
    expect(masked(Id, { n: "4111111111111111" })).toEqual({ n: "[pci]" });
  });

  test("keeps a value of a kind no option names, as a fallback handed back, and one a scalar option holds", () => {
    // biome-ignore lint/suspicious/noExplicitAny: a fallback that hands back the raw input, as one with a cast can.
    const back = (ctx: { input: unknown }): any => ctx.input;
    const Caught = z.object({ email: pii(z.string()) }).catch(back);
    // The object's marks apply to an object value: a string, an array or a map has none of its shape.
    expect(masked(Caught, "x")).toBe("x");
    expect(masked(Caught, ["x"])).toEqual(["x"]);
    const map = new Map([["email", "x"]]);
    expect(masked(z.object({ u: Caught }), { u: map })).toEqual({ u: map });
    expect(masked(Caught, { email: "S-1" })).toEqual({ email: "[pii]" });
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
});

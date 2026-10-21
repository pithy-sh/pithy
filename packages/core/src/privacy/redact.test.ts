// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { describe, expect, test } from "vitest";
import { z } from "zod";
import { SQLiteBoolean, SQLiteDate, sqliteJson } from "../data/codecs";
import { LogRecord, serializeRecord } from "../logger/record";
import { definePrivacyClass, pci, phi, pii, secret } from "./classes";
import { classifyPrivacy } from "./classify";
import { redact } from "./redact";

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
    const Prim = z.union([z.string(), pii(z.number())]);
    expect(redact(Prim, "plain")).toBe("[pii]");
    const Tagged = z.discriminatedUnion("t", [
      z.object({ t: z.literal("a"), e: z.string() }),
      z.object({ t: z.literal("b"), e: pii(z.string()) }),
    ]);
    expect(masked(Tagged, { t: "a", e: "S-1" })).toEqual({ t: "a", e: "[pii]" });
  });

  test("keeps every key the value holds, masking one no schema names where the position carries a mark", () => {
    // A key no option names is one a `.catch()` fallback or a mismatched value put there: masked, never dropped.
    expect(redact(User, { ...ada, extra: "S-x" } as typeof ada)).toEqual({
      id: "u_1",
      email: "[pii]",
      diagnosis: "[phi]",
      extra: "[phi]",
    });
    // Where the position carries no mark, it is kept as it is.
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
  });

  test("keeps every element a tuple has no item for", () => {
    expect(masked(z.union([z.tuple([z.string()]), z.any()]), ["a", "b", "c"])).toEqual(["a", "b", "c"]);
    // Handed more than it names, a marked tuple masks the extra element rather than dropping it.
    expect(redact(z.tuple([pii(z.string())]), ["S-1", "S-2"] as never)).toEqual(["[pii]", "[pii]"]);
  });

  test("walks a catch, a default, a readonly and a brand as the field they wrap", () => {
    const Wrapped = z.object({ e: pii(z.string()).brand<"E">(), n: z.string() }).readonly();
    expect(masked(Wrapped, { e: "S-1", n: "n" })).toEqual({ e: "[pii]", n: "n" });
    const Defaulted = z.object({ e: pii(z.string()) }).default({ e: "S-d" } as never);
    expect(masked(Defaulted, undefined)).toEqual({ e: "[pii]" });
    // A fallback's extra key is one no schema names, so the marked position masks it.
    const Caught = z
      .object({ e: pii(z.string()), n: z.number() })
      .catch((ctx) => ({ e: "x", n: 0, leak: String((ctx.input as { e: string }).e) }) as never);
    expect(masked(Caught, { e: "S-1", n: "bad" })).toEqual({ e: "[pii]", n: 0, leak: "[pii]" });
  });
});

describe("the rule: every other node is opaque", () => {
  const Profile = z.object({ e: pii(z.string()), n: z.string() });

  test("masks a JSON column with a marked field inside whole, with the strongest class it carries", () => {
    const Row = z.object({ id: z.string(), profile: sqliteJson(Profile) });
    expect(masked(Row, { id: "i", profile: '{"e":"S-1","n":"x"}' })).toEqual({ id: "i", profile: "[pii]" });
    expect(classifyPrivacy(Row)).toEqual([{ path: "profile", class: "pii" }]);
    const Mixed = sqliteJson(z.object({ e: pii(z.string()), d: phi(z.string()) }));
    expect(masked(Mixed, '{"e":"S-1","d":"S-2"}')).toBe("[phi]");
    expect(classifyPrivacy(Mixed)).toEqual([
      { path: "", class: "pii" },
      { path: "", class: "phi" },
    ]);
    // A column with no mark inside is kept as it is.
    const Plain = z.object({ settings: sqliteJson(z.object({ theme: z.string() })) });
    expect(masked(Plain, { settings: '{"theme":"dark"}' })).toEqual({ settings: { theme: "dark" } });
  });

  test("masks a transform, a pipe, a preprocess and a codec whole when a mark sits on either side", () => {
    class Account {
      constructor(readonly e: string) {}
    }
    const cases: [string, z.ZodType, unknown][] = [
      ["a transform to a class instance", Profile.transform((o) => new Account(o.e)), { e: "S-1", n: "x" }],
      ["a transform that renames", Profile.transform((o) => ({ moved: o.e })), { e: "S-1", n: "x" }],
      [
        "a pipe into an unmarked object",
        Profile.pipe(z.object({ e: z.string(), n: z.string() }) as never),
        { e: "S-1", n: "x" },
      ],
      ["a pipe into a marked object", z.object({ e: z.string() }).pipe(z.object({ e: pii(z.string()) })), { e: "S-1" }],
      ["a preprocess", z.preprocess((value) => value, Profile), { e: "S-1", n: "x" }],
      [
        "a codec marked on its app side",
        z.codec(z.string(), Profile, { decode: (s) => ({ e: s, n: s }), encode: (o) => o.n }),
        "S-1",
      ],
      [
        "a codec marked on its wire side",
        z.codec(Profile, z.object({ n: z.string() }), {
          decode: (o) => ({ n: o.e }),
          encode: (o) => ({ e: o.n, n: o.n }) as never,
        }),
        { e: "S-1", n: "x" },
      ],
    ];
    for (const [label, schema, wire] of cases) {
      expect([label, masked(schema, wire)]).toEqual([label, "[pii]"]);
      expect([label, classifyPrivacy(schema)]).toEqual([label, [{ path: "", class: "pii" }]]);
    }
    // The strongest class inside names the placeholder.
    const Mixed = z.object({ e: pii(z.string()), t: secret(z.string()) }).transform((o) => ({ ...o }));
    expect(masked(Mixed, { e: "S-1", t: "S-2" })).toBe("[secret]");
  });

  test("keeps an opaque node with no mark inside as it is", () => {
    const Plain = z.object({ n: z.string() }).transform((o) => ({ m: o.n }));
    expect(masked(Plain, { n: "x" })).toEqual({ m: "x" });
    const Field = z.object({ t: z.string().transform((s) => s.length), e: pii(z.string()) });
    expect(masked(Field, { t: "abc", e: "S-1" })).toEqual({ t: 3, e: "[pii]" });
    const Out = z.string().transform(() => JSON.parse('{"__proto__":{"x":1},"a":1}') as Record<string, unknown>);
    expect(Object.getPrototypeOf(masked(Out, "w"))).toBe(Object.prototype);
  });

  test("masks a set, a map, a promise, a function and a custom whole when it holds a mark", async () => {
    expect(masked(z.set(pii(z.string())), new Set(["S-1", "S-2"]))).toBe("[pii]");
    expect(masked(z.map(pii(z.string()), z.string()), new Map([["S-1", "home"]]))).toBe("[pii]");
    expect(masked(z.map(z.string(), z.object({ e: pii(z.string()) })), new Map([["k", { e: "S-1" }]]))).toBe("[pii]");
    const Fn = z.function({ input: [pii(z.string())], output: z.string() });
    expect(redact(Fn as never, ((s: string) => s) as never)).toBe("[pii]");
    const Later = z.promise(pii(z.string()));
    expect(redact(Later, Promise.resolve("S-1") as never)).toBe("[pii]");
    // Unmarked, each is kept as it is.
    const set = new Set(["a"]);
    expect(masked(z.set(z.string()), set)).toEqual(set);
    const fn = (s: string) => s;
    expect(redact(z.function({ input: [z.string()], output: z.string() }) as never, fn as never)).toBe(fn);
    class Acct {
      constructor(readonly e: string) {}
    }
    const instance = new Acct("a");
    expect(redact(z.object({ a: z.instanceof(Acct) }), { a: instance })).toEqual({ a: instance });
    // `any` and `unknown` carry no mark of their own, so what they hold is kept.
    expect(masked(z.object({ a: z.any(), u: z.unknown() }), { a: { x: 1 }, u: [2] })).toEqual({ a: { x: 1 }, u: [2] });
  });

  test("masks a position whole where an opaque node meets a mark, inside it or beside it", () => {
    const Marked = z.union([z.object({ id: z.string() }), Profile.transform((o) => ({ moved: o.e }))]);
    expect(masked(Marked, { e: "S-1", n: "x" })).toBe("[pii]");
    // A transform with no mark inside reads the same value the option beside it marks.
    const Either = z.union([
      z.object({ e: pii(z.email()) }),
      z.object({ e: z.string() }).transform((o) => ({ n: o.e })),
    ]);
    expect(masked(Either, { e: "S-1" })).toBe("[pii]");
    expect(classifyPrivacy(Either)).toEqual([{ path: "", class: "pii" }]);
    const Both = z.intersection(
      Profile,
      z.object({ e: z.string() }).transform((o) => ({ moved: o.e })),
    );
    expect(masked(Both, { e: "S-1", n: "x" })).toBe("[pii]");
    const Held = z.union([Profile, z.unknown()]);
    expect(masked(Held, { e: "S-1", n: "x" })).toBe("[pii]");
    // A scalar holds nothing else: a date did not come from the object option, and is kept.
    const Dated = z.union([z.object({ e: pii(z.string()) }), z.date()]);
    expect(redact(Dated, new Date(0))).toEqual(new Date(0));
    expect(classifyPrivacy(Dated)).toEqual([{ path: "e", class: "pii" }]);
  });

  test("does not see a check: a refine or an overwrite leaves the node the kind it was", () => {
    const Ref = Profile.refine(() => true);
    expect(masked(Ref, { e: "S-1", n: "x" })).toEqual({ e: "[pii]", n: "x" });
    expect(classifyPrivacy(Ref)).toEqual([{ path: "e", class: "pii" }]);
    const Trimmed = z.object({ e: pii(z.string().trim()), n: z.string().trim() });
    expect(masked(Trimmed, { e: " S-1 ", n: " x " })).toEqual({ e: "[pii]", n: "x" });
  });
});

/**
 * **The round-3 repros, as the rule decides them.** Each of these leaked, dropped or overflowed the stack under the
 * precision rules the coarse one replaced (`scratchpad/ship/132/verify-r3`).
 */
describe("regressions: round 3", () => {
  type Nd = { e: string; next?: Nd };
  const Nd: z.ZodType<Nd> = z.lazy(() => z.object({ e: pii(z.string()), next: Nd.optional() }));

  test("a recursive lazy terminates in classify and in redact, whatever is around it", () => {
    expect(classifyPrivacy(Nd)).toEqual([{ path: "e", class: "pii" }]);
    expect(classifyPrivacy(Nd.transform((n) => n))).toEqual([{ path: "", class: "pii" }]);
    expect(masked(Nd, { e: "S-1", next: { e: "S-2" } })).toEqual({ e: "[pii]", next: { e: "[pii]" } });
    expect(
      redact(
        Nd.transform((n) => n),
        { e: "S-1" },
      ),
    ).toBe("[pii]");
    expect(
      redact(
        z.object({ n: Nd }).refine(() => true),
        { n: { e: "S-1" } },
      ),
    ).toEqual({ n: { e: "[pii]" } });
    expect(redact(z.union([z.string().transform((x) => x), Nd]), { e: "S-1" } as never)).toBe("[pii]");
    expect(
      redact(
        z.preprocess((x) => x, Nd),
        { e: "S-1" },
      ),
    ).toBe("[pii]");
    const G: z.ZodType = z.object({
      e: pii(z.string()),
      get kids() {
        return z.array(G);
      },
    });
    expect(
      redact(
        G.transform((x) => x),
        { e: "S-1", kids: [] } as never,
      ),
    ).toBe("[pii]");
    expect(classifyPrivacy(G.transform((x) => x))).toEqual([{ path: "", class: "pii" }]);
    type L2 = string | L2[];
    const L2: z.ZodType<L2> = z.lazy(() => z.union([z.string(), z.array(L2)]));
    expect(
      redact(
        L2.transform((x) => x),
        "a",
      ),
    ).toBe("a");
  });

  const Profile = z.object({ e: pii(z.string()) });
  const Tr = z.object({ e: z.string() }).transform((o) => ({ copy: o.e }));
  const S = z.union([Tr, Profile]);

  test.each<[string, z.ZodType, unknown, unknown]>([
    ["A0 a union of a transform and the marked object", S, { e: "S-1" }, "[pii]"],
    [
      "A1 an intersection of a preprocess over it and it",
      z.intersection(
        z.preprocess((x) => x, S),
        S,
      ),
      { e: "S-1" },
      "[pii]",
    ],
    ["A2 a union of a preprocess over it and it", z.union([z.preprocess((x) => x, S), S]), { e: "S-1" }, "[pii]"],
    [
      "A3 an object field holding that intersection",
      z.object({
        f: z.intersection(
          z.preprocess((x) => x, S),
          S,
        ),
      }),
      { f: { e: "S-1" } },
      { f: "[pii]" },
    ],
    [
      "A4 a transform piped into it, beside it",
      z.intersection(
        z
          .any()
          .transform((x) => x)
          .pipe(S),
        S,
      ),
      { e: "S-1" },
      "[pii]",
    ],
    [
      "A5 a preprocess over it beside a loose object",
      z.intersection(
        z.preprocess((x) => x, S),
        z.looseObject({}),
      ),
      { e: "S-1" },
      "[pii]",
    ],
    [
      "A6 a partial marked object beside a renaming transform",
      z.intersection(
        Profile.partial(),
        z.object({ e: z.string() }).transform((o) => ({ copy: o.e })),
      ),
      { e: "S-1" },
      "[pii]",
    ],
    ["B1 a preprocess over it", z.preprocess((x) => x, S), { e: "S-1" }, "[pii]"],
    [
      "B2 an adopter's JSON codec over it",
      z.object({ p: z.codec(z.string(), S, { decode: (s) => JSON.parse(s), encode: (v) => JSON.stringify(v) }) }),
      { p: '{"e":"S-1"}' },
      { p: "[pii]" },
    ],
    ["B3 sqliteJson over it", z.object({ p: sqliteJson(S) }), { p: '{"e":"S-1"}' }, { p: "[pii]" }],
    [
      "B4 a preprocess over an intersection",
      z.preprocess((x) => x, z.intersection(Profile.partial(), Tr)),
      { e: "S-1" },
      "[pii]",
    ],
    [
      "B5 a preprocess over a discriminated union",
      z.preprocess(
        (x) => x,
        z.discriminatedUnion("t", [
          z.object({ t: z.literal("a"), e: z.string() }).transform((o) => ({ t: o.t, copy: o.e })),
          z.object({ t: z.literal("b"), e: pii(z.string()) }),
        ]),
      ),
      { t: "a", e: "S-1" },
      "[pii]",
    ],
    [
      "B7 a transform piped into it",
      z
        .object({ e: z.string() })
        .transform((x) => x)
        .pipe(S),
      { e: "S-1" },
      "[pii]",
    ],
    [
      "B8 a preprocess over a marked transform",
      z.preprocess(
        (x) => x,
        Profile.transform((o) => ({ copy: o.e })),
      ),
      { e: "S-1" },
      "[pii]",
    ],
    [
      "B9 a preprocess over a lazy",
      z.preprocess(
        (x) => x,
        z.lazy(() => S),
      ),
      { e: "S-1" },
      "[pii]",
    ],
    ["B10 a preprocess over an optional", z.preprocess((x) => x, S.optional()), { e: "S-1" }, "[pii]"],
    ["B11 an array of preprocesses", z.array(z.preprocess((x) => x, S)), [{ e: "S-1" }], ["[pii]"]],
    [
      "B12 a preprocess over a union with a catch",
      z.preprocess((x) => x, z.union([z.object({ e: z.string() }).catch({ e: "x" }), Profile])),
      { e: "S-1" },
      "[pii]",
    ],
  ])("%s", (_label, schema, wire, expected) => {
    const out = masked(schema, wire);
    expect(out).toEqual(expected);
    expect(raw(out)).toEqual([]);
  });

  test.each<[string, z.ZodType, unknown, unknown]>([
    ["E1 a short tuple beside any", z.union([z.tuple([z.string()]), z.any()]), ["a", "b", "c"], ["a", "b", "c"]],
    [
      "E2 a short tuple beside a transform",
      z.union([z.tuple([z.string()]), z.string().transform((s) => [s, s, s])]),
      "a",
      ["a", "a", "a"],
    ],
    ["E3 a short tuple beside unknown", z.union([z.tuple([z.string()]), z.unknown()]), ["a", "b"], ["a", "b"]],
    [
      "E4 a short tuple beside a custom",
      z.union([z.tuple([z.string()]), z.custom<unknown>(() => true)]),
      ["a", "b"],
      ["a", "b"],
    ],
    ["E5 a short marked tuple beside any", z.union([z.tuple([pii(z.string())]), z.any()]), ["S-1", "S-2"], "[pii]"],
    [
      "E6 a record of a short tuple or any",
      z.record(z.string(), z.union([z.tuple([z.string()]), z.any()])),
      { k: ["a", "b"] },
      { k: ["a", "b"] },
    ],
    [
      "E9 a map keyed by a marked transform",
      z.map(
        z.object({ e: pii(z.string()) }).transform((o) => o.e),
        z.string(),
      ),
      new Map([[{ e: "S-1" }, "v"]]),
      "[pii]",
    ],
    [
      "E10 a record keyed by an unmarked transform",
      z.record(
        z.string().transform((k) => k),
        pii(z.string()),
      ),
      { k: "S-1" },
      { k: "[pii]" },
    ],
    [
      "E11 a set of marked transforms",
      z.set(z.object({ e: pii(z.string()) }).transform((o) => o.e)),
      new Set([{ e: "S-1" }, { e: "S-2" }]),
      "[pii]",
    ],
    [
      "E12 a tuple rest that transforms a mark",
      z.tuple(
        [z.string()],
        z.object({ e: pii(z.string()) }).transform((o) => ({ c: o.e })),
      ),
      ["a", { e: "S-1" }],
      ["a", "[pii]"],
    ],
    [
      "E14 a transform that moves a key",
      z.object({ a: z.object({ e: pii(z.string()) }).transform((o) => ({ moved: o.e })) }),
      { a: { e: "S-1" } },
      { a: "[pii]" },
    ],
    [
      "E18 a getter whose kids transform",
      (() => {
        const G: z.ZodType = z.object({
          e: pii(z.string()),
          get kids() {
            return z.array(G).transform((a) => (a as { e: string }[]).map((k) => ({ c: k.e })));
          },
        });
        return G;
      })(),
      { e: "S-1", kids: [{ e: "S-2", kids: [] }] },
      { e: "[pii]", kids: "[pii]" },
    ],
    [
      "E19 a record of preprocesses over a union with a transform",
      z.record(
        z.string(),
        z.preprocess(
          (x) => x,
          z.union([z.object({ e: z.string() }).transform((o) => ({ c: o.e })), z.object({ e: pii(z.string()) })]),
        ),
      ),
      { k: { e: "S-1" } },
      { k: "[pii]" },
    ],
    [
      "E20 a codec marked on its app side only",
      z.codec(z.string(), z.object({ e: pii(z.string()), n: z.string() }), {
        decode: (s) => ({ e: s, n: s }),
        encode: (o) => o.e,
      }),
      "S-1",
      "[pii]",
    ],
    [
      "E22 a codec chain into a transform",
      z
        .codec(z.string(), z.object({ e: pii(z.string()) }), { decode: (s) => ({ e: s }), encode: (o) => o.e })
        .pipe(z.object({ e: z.string() }).transform((o) => ({ c: o.e })) as never),
      "S-1",
      "[pii]",
    ],
    [
      "E25 a preprocess over a partial marked object beside a transform",
      z.intersection(
        z.preprocess((x) => x, z.object({ e: pii(z.string()) }).partial()),
        z.object({ e: z.string() }).transform((o) => ({ c: o.e })),
      ),
      { e: "S-1" },
      "[pii]",
    ],
  ])("%s", (_label, schema, wire, expected) => {
    const out = masked(schema, wire);
    expect(out).toEqual(expected);
    expect(raw(out)).toEqual([]);
  });

  test("T2, T2b, T4: the type agrees with what redact returns", () => {
    const P2 = z.object({ e: pii(z.string()), n: z.string() });
    // An adopter codec of sqliteJson's own shape whose decode copies the mark: masked whole, typed a string.
    const Look = z.codec(z.union([z.string(), P2]), P2, {
      decode: (v) => {
        const o = typeof v === "string" ? JSON.parse(v) : v;
        return { e: o.e, n: o.e };
      },
      encode: (v) => JSON.stringify(v),
    });
    const look: string = redact(Look, Look.parse('{"e":"S-1","n":"x"}'));
    expect(look).toBe("[pii]");
    const column: { p: string } = redact(z.object({ p: sqliteJson(P2) }), { p: { e: "S-1" as never, n: "x" } });
    expect(column).toEqual({ p: "[pii]" });
    const Ref = P2.refine(() => true);
    const refined: { e: string; n: string } = redact(Ref, Ref.parse({ e: "S-1", n: "x" }));
    expect(refined).toEqual({ e: "[pii]", n: "x" });
  });
});

/**
 * **Regressions from the fourth review round** (#132): a recursive schema built by a factory, which no identity guard
 * recognizes, and a coercion, which reads the whole input a structural option beside it reads.
 */
describe("regressions: round 4", () => {
  // A factory hands back a new schema at every level, so the schema-only walks have no node to stop on.
  // biome-ignore lint/suspicious/noExplicitAny: a factory's type is circular, and TypeScript infers none.
  const mkLazy = (): any => z.lazy(() => z.object({ n: z.string(), e: pii(z.string()), kid: mkLazy().optional() }));
  // biome-ignore lint/suspicious/noExplicitAny: as above.
  const mkGet = (): any =>
    z.object({
      n: z.string(),
      e: pii(z.string()),
      get kid() {
        return mkGet().optional();
      },
    });
  const tree = { n: "a", e: "S-1", kid: { n: "b", e: "S-2" } };

  test("never throws on a factory-built recursive schema: it lists the cut-off position as secret, truncated", () => {
    for (const schema of [mkLazy(), mkGet()]) {
      const fields = classifyPrivacy(schema);
      expect(fields).toContainEqual({ path: "e", class: "pii" });
      expect(fields).toContainEqual({ path: "kid.e", class: "pii" });
      const cut = fields.filter((field) => field.truncated === true);
      expect(cut.length).toBeGreaterThan(0);
      for (const field of cut) expect(field.class).toBe("secret");
      expect(fields.filter((field) => field.truncated !== undefined && field.truncated !== true)).toEqual([]);
    }
  });

  // biome-ignore lint/suspicious/noExplicitAny: as above, with no mark anywhere.
  const mkPlain = (): any => z.object({ a: z.string(), next: z.lazy(mkPlain).optional() });
  // biome-ignore lint/suspicious/noExplicitAny: as above, through a getter.
  const mkPlainGet = (): any =>
    z.object({
      a: z.string(),
      get k() {
        return mkPlainGet().optional();
      },
    });

  test.each<[string, z.ZodType, unknown]>([
    ["F2 a transform over a marked factory", z.object({ t: mkLazy().transform((x: unknown) => x) }), { t: tree }],
    ["F3 a marked factory beside an unknown", z.object({ t: z.union([mkLazy(), z.unknown()]) }), { t: tree }],
    ["F8 a transform over a getter factory", z.object({ t: mkGet().transform((x: unknown) => x) }), { t: tree }],
    [
      "F5 a transform over an unmarked factory",
      z.object({ t: mkPlain().transform((x: unknown) => x) }),
      { t: { a: "x" } },
    ],
    ["F6 a set of an unmarked factory", z.object({ t: z.set(mkPlain()) }), { t: new Set([{ a: "x" }]) }],
    ["F9 a JSON column over an unmarked factory", z.object({ t: sqliteJson(mkPlainGet()) }), { t: '{"a":"x"}' }],
  ])("%s: an opaque node it cannot search to the end is masked whole as secret", (_label, schema, wire) => {
    expect(masked(schema, wire)).toEqual({ t: "[secret]" });
    expect(classifyPrivacy(schema)).toContainEqual({ path: "t", class: "secret", truncated: true });
  });

  test("lists an unmarked factory beside a mark without throwing, and keeps its value", () => {
    const schema = z.object({ u: mkPlain(), e: pii(z.string()) });
    expect(masked(schema, { u: { a: "x", next: { a: "y" } }, e: "S-1" })).toEqual({
      u: { a: "x", next: { a: "y" } },
      e: "[pii]",
    });
    const fields = classifyPrivacy(schema);
    expect(fields).toContainEqual({ path: "e", class: "pii" });
    expect(fields.filter((field) => field.path.startsWith("u.")).every((field) => field.truncated === true)).toBe(true);
  });

  test("stops a lazy that returns a new lazy at every level, closed", () => {
    // biome-ignore lint/suspicious/noExplicitAny: a chain of lazies has no type to infer.
    const chain = (): any => z.lazy(chain);
    expect(classifyPrivacy(z.object({ c: chain() }))).toEqual([{ path: "c", class: "secret", truncated: true }]);
    expect(redact(z.object({ c: chain() }), { c: "x" } as never)).toEqual({ c: "[secret]" });
  });

  test("masks a value nested past the depth limit as secret, and never overflows the stack", () => {
    type Link = { e: string; next?: Link };
    const Link: z.ZodType<Link> = z.lazy(() => z.object({ e: pii(z.string()), next: Link.optional() }));
    let value: Link = { e: "S-0" };
    for (let index = 1; index < 400; index += 1) value = { e: `S-${index}`, next: value };
    const out = redact(Link, Link.parse(value));
    expect(raw(out)).toEqual([]);
    expect(JSON.stringify(out)).toContain('"[secret]"');
    let shallow: unknown = out;
    for (let index = 0; index < 10; index += 1) {
      expect((shallow as Link).e).toBe("[pii]");
      shallow = (shallow as Link).next;
    }
  });

  test("reads a lazy through the schema parse ran, never by calling its getter again", () => {
    let calls = 0;
    const Impure = z.lazy(() => (calls++ === 0 ? z.object({ e: pii(z.string()) }) : z.object({ e: z.string() })));
    const parsed = Impure.parse({ e: "S-1" });
    expect(redact(Impure, parsed)).toEqual({ e: "[pii]" });
    expect(classifyPrivacy(Impure)).toEqual([{ path: "e", class: "pii" }]);
    expect(calls).toBe(1);
  });

  test("reads an object's getter through the shape parse ran", () => {
    let calls = 0;
    const Impure = z.object({
      get e() {
        return calls++ === 0 ? pii(z.string()) : z.string();
      },
    });
    const parsed = Impure.parse({ e: "S-1" });
    expect(redact(Impure, parsed as never)).toEqual({ e: "[pii]" });
    expect(classifyPrivacy(Impure)).toEqual([{ path: "e", class: "pii" }]);
  });

  test("still masks a factory-built recursive schema by its value, where the walk follows the value", () => {
    expect(masked(mkLazy(), tree)).toEqual({ n: "a", e: "[pii]", kid: { n: "b", e: "[pii]" } });
    expect(masked(mkGet(), tree)).toEqual({ n: "a", e: "[pii]", kid: { n: "b", e: "[pii]" } });
  });

  test.each<[string, z.ZodType, unknown]>([
    ["K1 a tuple beside a coerced string", z.union([z.tuple([pii(z.string())]), z.coerce.string()]), ["S-1", "x"]],
    [
      "K2 a capped array beside a coerced string",
      z.object({ tags: z.union([z.array(pii(z.string())).max(1), z.coerce.string()]) }),
      { tags: ["S-1", "S-2"] },
    ],
    [
      "K5 a phi array beside a coerced date",
      z.union([z.array(phi(z.string())).length(2), z.coerce.date()]),
      ["1990-05-01"],
    ],
  ])("%s: a coercion beside a mark masks the position whole", (_label, schema, wire) => {
    const out = masked(schema, wire);
    expect(raw(out)).toEqual([]);
    expect(JSON.stringify(out)).not.toMatch(/S-|1990/);
  });

  test("lists a coercion beside a mark at its own position, and keeps a plain scalar beside one", () => {
    expect(classifyPrivacy(z.object({ tags: z.union([z.array(pii(z.string())).max(1), z.coerce.string()]) }))).toEqual([
      { path: "tags", class: "pii" },
    ]);
    expect(classifyPrivacy(z.object({ tags: z.union([z.array(pii(z.string())), z.string()]) }))).toEqual([
      { path: "tags[]", class: "pii" },
    ]);
    expect(masked(z.object({ n: z.coerce.number(), e: pii(z.string()) }), { n: "4", e: "S-1" })).toEqual({
      n: 4,
      e: "[pii]",
    });
  });
});

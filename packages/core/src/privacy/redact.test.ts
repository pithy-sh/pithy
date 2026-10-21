// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { describe, expect, test } from "vitest";
import { z } from "zod";
import { SQLiteDate, sqliteJson } from "../data/codecs";
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

  test("masks a codec field and a marked field inside a JSON column", () => {
    const Row = z
      .object({
        bornAt: pii(SQLiteDate).describe("Date of birth."),
        profile: sqliteJson(z.object({ phone: pii(z.string()), city: z.string() })).describe("The profile."),
      })
      .describe("A row.");
    const row = Row.parse({ bornAt: 0, profile: JSON.stringify({ phone: "555", city: "Oslo" }) });
    expect(redact(Row, row)).toEqual({ bornAt: "[pii]", profile: { phone: "[pii]", city: "Oslo" } });
  });

  test("masks a whole marked object", () => {
    const Visit = z.object({ notes: phi(z.object({ text: z.string() })).describe("Clinical notes.") }).describe("v");
    expect(redact(Visit, Visit.parse({ notes: { text: "x" } }))).toEqual({ notes: "[phi]" });
  });

  test("redacts the option of a union the value matches, and every option's markers when none does", () => {
    const Contact = z
      .union([
        z.object({ kind: z.literal("email"), email: pii(z.string()) }),
        z.object({ kind: z.literal("token"), token: secret(z.string()) }),
      ])
      .describe("A contact.");
    expect(redact(Contact, { kind: "email", email: "a@b.c" } as z.output<typeof Contact>)).toEqual({
      kind: "email",
      email: "[pii]",
    });
    expect(redact(Contact, { kind: "other", email: "a@b.c", token: "t" } as never)).toEqual({
      kind: "other",
      email: "[pii]",
      token: "[secret]",
    });
  });

  test("masks a record's values and a tuple's positions", () => {
    const Shape = z
      .object({
        notes: z.record(z.string(), phi(z.string())).describe("Notes."),
        pair: z.tuple([z.string(), secret(z.string())]).describe("A pair."),
      })
      .describe("A shape.");
    expect(redact(Shape, Shape.parse({ notes: { a: "x", b: "y" }, pair: ["id", "tok"] }))).toEqual({
      notes: { a: "[phi]", b: "[phi]" },
      pair: ["id", "[secret]"],
    });
  });

  test("uses an adopter class's own mask", () => {
    const genetic = definePrivacyClass({ name: "genetic_redact", mask: () => "[genome]" });
    const Sample = z.object({ sequence: genetic(z.string()) }).describe("A sample.");
    expect(redact(Sample, Sample.parse({ sequence: "ACGT" }))).toEqual({ sequence: "[genome]" });
  });

  test("masks with the class placeholder when the class was never registered", () => {
    const Odd = z.object({ value: z.string().meta({ privacy: "unregistered_redact" }) }).describe("o");
    expect(redact(Odd, { value: "x" })).toEqual({ value: "[unregistered_redact]" });
  });

  test("follows a lazy schema, so a recursive one is masked at every depth", () => {
    interface Node {
      name: string;
      diag: string;
      children: Node[];
    }
    const Node: z.ZodType<Node> = z.lazy(() =>
      z.object({ name: z.string(), diag: phi(z.string()), children: z.array(Node) }),
    );
    const Tree = z.object({ root: Node }).describe("A tree.");
    const tree = { root: { name: "n", diag: "flu", children: [{ name: "m", diag: "cold", children: [] }] } };
    expect(redact(Tree, tree as never)).toEqual({
      root: { name: "n", diag: "[phi]", children: [{ name: "m", diag: "[phi]", children: [] }] },
    });
  });

  test("masks a key an object's catchall marks", () => {
    const Bag = z.object({ id: z.string() }).catchall(pii(z.string())).describe("A bag.");
    expect(redact(Bag, Bag.parse({ id: "1", e: "a@b.c" }))).toEqual({ id: "1", e: "[pii]" });
  });

  test("masks a position any union option marks, whichever option the value parses as", () => {
    const Basic = z.object({ id: z.string() });
    const Full = z.object({ id: z.string(), email: pii(z.string()) });
    // Parse keeps what the first option keeps, and drops `email`; redact keeps what any option names, masked.
    const U = z.union([Basic, Full]).describe("Either.");
    expect(redact(U, { id: "u1", email: "a@b.c" } as never)).toEqual({ id: "u1", email: "[pii]" });
    const Loose = z.union([Basic.loose(), Full]).describe("Either, loosely.");
    expect(redact(Loose, { id: "u1", email: "a@b.c" } as never)).toEqual({ id: "u1", email: "[pii]" });
    // An option that marks the root masks the value, even one the marked option would refuse.
    const Prim = z.union([z.string(), pii(z.number())]).describe("A string or a marked number.");
    expect(redact(Prim, "plain")).toBe("[pii]");
  });

  test("drops a key the schema does not name, the way parse strips it, so its type tells the truth", () => {
    expect(redact(User, { ...ada, extra: 1 } as typeof ada)).toEqual({
      id: "u_1",
      email: "[pii]",
      diagnosis: "[phi]",
    });
    const narrow = redact(User.pick({ id: true }), ada);
    expect(narrow).toEqual({ id: "u_1" });
  });

  test("keeps every key an intersection names on either side, and masks each side's markers", () => {
    const Both = z.intersection(z.object({ id: z.string() }), z.object({ email: pii(z.string()) }));
    expect(redact(Both, Both.parse({ id: "u", email: "a@b.c", extra: 1 }))).toEqual({ id: "u", email: "[pii]" });
    expect(redact(Both, { id: "u", email: "a@b.c", extra: 1 } as never)).toEqual({ id: "u", email: "[pii]" });
  });

  test("keeps a nested key either side of an intersection names, and masks it at every depth", () => {
    const Both = z.intersection(
      z.object({ p: z.object({ name: z.string(), deep: z.object({ a: z.string() }) }) }),
      z.object({ p: z.object({ email: pii(z.string()), deep: z.object({ b: secret(z.string()) }) }) }),
    );
    const value = Both.parse({ p: { name: "Ada", email: "a@b.c", deep: { a: "x", b: "y", c: "z" }, extra: 1 } });
    expect(redact(Both, value)).toEqual({ p: { name: "Ada", email: "[pii]", deep: { a: "x", b: "[secret]" } } });
  });

  test("keeps a nested key any option names, masks it when any option marks it, and drops one none names", () => {
    const U = z.union([
      z.object({ p: z.object({ x: z.string() }) }),
      z.object({ p: z.object({ y: pii(z.string()) }) }),
    ]);
    const value = { p: { x: "kept", y: "a@b.c", z: "dropped" } };
    expect(redact(U, value as never)).toEqual({ p: { x: "kept", y: "[pii]" } });
    const Loose = z.union([
      z.object({ p: z.looseObject({ x: z.string() }) }),
      z.object({ p: z.object({ y: pii(z.string()) }) }),
    ]);
    expect(redact(Loose, value as never)).toEqual({ p: { x: "kept", y: "[pii]", z: "dropped" } });
  });

  test("masks what any option of either side marks, wherever the value sits", () => {
    const Left = z.union([z.object({ b: pii(z.string()), z: z.number() }), z.object({ c: z.string() })]);
    const Right = z.union([z.object({ b: pii(z.string()), z: z.number() }), z.object({ d: z.string() })]);
    const Both = z.intersection(Left, Right);
    expect(redact(Both, { b: "a@b.c", c: "c", d: "d" } as never)).toEqual({ b: "[pii]", c: "c", d: "d" });
  });

  test("does not throw when an option's parse does, and masks by every option instead", () => {
    // Zod throws, rather than reports, an intersection whose sides parse to values it cannot merge.
    const U = z.union([z.intersection(z.set(z.string()), z.set(z.string())), z.set(pii(z.string()))]);
    expect([...redact(U, new Set(["a@b.c"]))]).toEqual(["[pii]"]);
  });

  test("chooses an option by the unmasked value, so a mask cannot steer a later union to a looser option", () => {
    // The left side marks a field the right side's union refines: tested against `[pii]`, the strict option fails,
    // the loose one applies, and the field only the strict option marks would come out raw.
    const Email = z.intersection(
      z.object({ e: pii(z.email()) }),
      z.union([z.object({ e: z.email(), s: pii(z.string()) }), z.looseObject({})]),
    );
    expect(redact(Email, Email.parse({ e: "a@b.co", s: "S-1" }))).toEqual({ e: "[pii]", s: "[pii]" });
    const Count = z.intersection(
      z.object({ n: pii(z.number()) }),
      z.union([z.object({ n: z.number(), s: pii(z.string()) }), z.looseObject({})]),
    );
    expect(redact(Count, Count.parse({ n: 5, s: "S-1" }))).toEqual({ n: "[pii]", s: "[pii]" });
    const Refined = z.intersection(
      z.object({ p: z.object({ id: pii(z.string().refine((v) => v.length >= 5)) }) }),
      z.object({ p: z.union([z.object({ id: z.string().min(5), s: secret(z.string()) }), z.looseObject({})]) }),
    );
    expect(redact(Refined, Refined.parse({ p: { id: "abcdefg", s: "S-s" } }))).toEqual({
      p: { id: "[pii]", s: "[secret]" },
    });
  });

  test("keeps a key a loose object's catchall lets through", () => {
    const Loose = z.looseObject({ id: z.string() });
    expect(redact(Loose, Loose.parse({ id: "u", extra: 1 }))).toEqual({ id: "u", extra: 1 });
  });

  test("masks a marked record key and a marked map key, keeping entries apart", () => {
    const ByEmail = z.object({ m: z.record(pii(z.string()), z.number()) });
    const masked = redact(ByEmail, ByEmail.parse({ m: { "a@b.c": 1, "d@e.f": 2 } }));
    expect(Object.keys(masked.m)).toHaveLength(2);
    expect(Object.values(masked.m).sort()).toEqual([1, 2]);
    expect(JSON.stringify(masked)).not.toContain("@");
    expect(Object.keys(masked.m).every((key) => key.startsWith("[pii]"))).toBe(true);
    const ByPhone = z.map(pii(z.string()), z.string());
    const map = redact(ByPhone, ByPhone.parse(new Map([["555-0100", "home"]])));
    expect([...map.keys()]).toEqual(["[pii]"]);
    expect([...map.values()]).toEqual(["home"]);
  });

  test("masks an option's marked field when a codec or a transform in that option would refuse the app value", () => {
    const isoDate = z.codec(z.iso.datetime(), z.date(), {
      decode: (wire: string) => new Date(wire),
      encode: (date: Date) => date.toISOString(),
    });
    const Codec = z.union([z.object({ at: isoDate, s: pii(z.string()) }), z.looseObject({})]);
    const codec = Codec.parse({ at: "2026-01-01T00:00:00Z", s: "S-1" });
    expect(redact(Codec, codec)).toEqual({ at: new Date("2026-01-01T00:00:00Z"), s: "[pii]" });
    const Transform = z.union([
      z.object({ n: z.string().transform((wire) => wire.length), s: pii(z.string()) }),
      z.looseObject({}),
    ]);
    expect(redact(Transform, Transform.parse({ n: "abc", s: "S-1" }))).toEqual({ n: 3, s: "[pii]" });
    // With no loose fallback, the option that took the value is still the one that marks it, and nothing is dropped.
    const Strict = z.union([
      z.object({ n: z.string().transform((wire) => wire.length), s: pii(z.string()) }),
      z.object({ s: z.string() }),
    ]);
    expect(redact(Strict, Strict.parse({ n: "abc", s: "S-1" }))).toEqual({ n: 3, s: "[pii]" });
    const Discriminated = z.discriminatedUnion("t", [
      z.object({ t: z.literal("a"), at: isoDate, s: pii(z.string()) }),
      z.looseObject({ t: z.literal("b") }),
    ]);
    const tagged = Discriminated.parse({ t: "a", at: "2026-01-01T00:00:00Z", s: "S-1" });
    expect(redact(Discriminated, tagged)).toMatchObject({ t: "a", s: "[pii]" });
  });

  test("masks a field either side of a pipe marks, and agrees with classifyPrivacy", () => {
    // The input side marks `s`; the output side, which parse returns, names it unmarked.
    const Pipe = z.object({ s: pii(z.string()) }).pipe(z.object({ s: z.string() }) as z.ZodType as never);
    expect(redact(Pipe, Pipe.parse({ s: "S-1" }))).toEqual({ s: "[pii]" });
    expect(classifyPrivacy(Pipe)).toEqual([{ path: "s", class: "pii" }]);
    // A transform's output is opaque: what its marked input became cannot be read off it, so it is masked whole.
    const Transformed = z.object({ s: pii(z.string()) }).pipe(z.transform((value) => value));
    expect(redact(Transformed, Transformed.parse({ s: "S-1" }))).toBe("[pii]");
    const Wire = z.codec(z.object({ s: pii(z.string()) }), z.object({ s: z.string() }), {
      decode: (wire) => ({ s: String(wire.s) }),
      encode: (app) => ({ s: pii(z.string()).parse(app.s) }),
    });
    // A codec's decode is a function too, so a codec over a marked wire side is masked whole.
    expect(redact(Wire, Wire.parse({ s: "S-1" }))).toBe("[pii]");
    expect(classifyPrivacy(Wire)).toEqual([
      { path: "", class: "pii" },
      { path: "s", class: "pii" },
    ]);
  });

  test("masks a codec whole when its app side does not mark what its wire side marks", () => {
    const Moved = z.codec(z.object({ email: pii(z.string()) }), z.object({ name: z.string() }), {
      decode: (wire) => ({ name: wire.email }),
      encode: (app) => ({ email: app.name as never }),
    });
    expect(redact(Moved, Moved.parse({ email: "S-1" }))).toBe("[pii]");
    const Nested = z.object({ u: Moved, id: z.string() });
    expect(redact(Nested, Nested.parse({ u: { email: "S-1" }, id: "i" }))).toEqual({ u: "[pii]", id: "i" });
    const FromArray = z.codec(z.array(pii(z.string())), z.object({ first: z.string() }), {
      decode: (wire) => ({ first: String(wire[0]) }),
      encode: (app) => [app.first as never],
    });
    expect(redact(FromArray, FromArray.parse(["S-1"]))).toBe("[pii]");
    expect(classifyPrivacy(Moved)).toEqual([
      { path: "", class: "pii" },
      { path: "email", class: "pii" },
    ]);
    expect(classifyPrivacy(Nested)).toContainEqual({ path: "u", class: "pii" });
    // A codec whose marks sit on its app side only is walked as before: a JSON column keeps its shape.
    const Column = sqliteJson(z.object({ phone: pii(z.string()), city: z.string() }));
    expect(redact(Column, Column.parse('{"phone":"S-1","city":"c"}'))).toEqual({ phone: "[pii]", city: "c" });
    // A recursive codec is decided once, and the walk ends.
    type Node = { e: string; kids: Node[] };
    const Tree: z.ZodType<Node> = z.lazy(() => sqliteJson(z.object({ e: pii(z.string()), kids: z.array(Tree) })));
    const tree = Tree.parse({ e: "S-1", kids: [{ e: "S-2", kids: [] }] });
    expect(redact(Tree, tree)).toEqual({ e: "[pii]", kids: [{ e: "[pii]", kids: [] }] });
  });

  test("masks an object whole when an overwrite over it could move a marked value", () => {
    const Copied = z.object({ email: pii(z.string()), name: z.string() }).overwrite((v) => ({ ...v, name: v.email }));
    expect(redact(Copied, Copied.parse({ email: "S-1", name: "n" }))).toBe("[pii]");
    const Field = z.object({ u: Copied, id: z.string() });
    expect(redact(Field, Field.parse({ u: { email: "S-1", name: "n" }, id: "i" }))).toEqual({ u: "[pii]", id: "i" });
    expect(classifyPrivacy(Copied)).toEqual([
      { path: "", class: "pii" },
      { path: "email", class: "pii" },
    ]);
    // A marked leaf with an overwrite of its own is masked by its own marker, and an unmarked one is left alone.
    const Trimmed = z.object({ e: pii(z.string().trim()), n: z.string().trim() });
    expect(redact(Trimmed, Trimmed.parse({ e: " S-1 ", n: " x " }))).toEqual({ e: "[pii]", n: "x" });
    const Plain = z.object({ n: z.string() }).overwrite((v) => ({ n: v.n.toUpperCase() }));
    expect(redact(Plain, Plain.parse({ n: "x" }))).toEqual({ n: "X" });
  });

  test("keeps an own __proto__ key as an own key", () => {
    const Meta = z.object({ meta: z.unknown() });
    const value = Meta.parse({ meta: JSON.parse('{"__proto__":{"x":1},"a":1}') });
    const masked = redact(Meta, value) as { meta: Record<string, unknown> };
    expect(Object.hasOwn(masked.meta, "__proto__")).toBe(true);
    expect(Object.getPrototypeOf(masked.meta)).toBe(Object.prototype);
    expect(Object.keys(masked.meta)).toEqual(["__proto__", "a"]);
    expect(JSON.stringify(masked)).toBe(JSON.stringify(value));
    const Out = z.string().transform(() => JSON.parse('{"__proto__":{"x":1},"a":1}') as Record<string, unknown>);
    const out = redact(Out, Out.parse("w"));
    expect(Object.hasOwn(out, "__proto__")).toBe(true);
    expect(Object.getPrototypeOf(out)).toBe(Object.prototype);
    // A record's parse drops the key itself; handed one anyway, redact still keeps it as a key.
    const Keyed = z.record(z.string(), z.number());
    const rec = redact(Keyed, JSON.parse('{"__proto__":1,"b":2}') as Record<string, number>);
    expect(Object.keys(rec)).toEqual(["__proto__", "b"]);
    expect(Object.getPrototypeOf(rec)).toBe(Object.prototype);
  });

  test("never lets a masked key overwrite a literal key equal to its placeholder", () => {
    const Rec = z.record(z.union([pii(z.email()), z.string()]), z.string());
    const rec = redact(Rec, { "a@b.co": "v1", "[pii]": "v2" });
    expect(Object.keys(rec)).toHaveLength(2);
    expect(Object.values(rec).sort()).toEqual(["v1", "v2"]);
    expect(JSON.stringify(rec)).not.toContain("@");
    const Plain = z.record(z.string(), z.string()).and(z.record(pii(z.email()), z.string()));
    expect(Object.keys(redact(Plain, { "[pii]": "v2", "a@b.co": "v1" }))).toHaveLength(2);
    const ByKey = z.map(z.union([pii(z.email()), z.string()]), z.string());
    const map = redact(
      ByKey,
      new Map([
        ["a@b.co", "v1"],
        ["[pii]", "v2"],
      ]),
    );
    expect(map.size).toBe(2);
    expect([...map.values()].sort()).toEqual(["v1", "v2"]);
    expect([...map.keys()].some((key) => String(key).includes("@"))).toBe(false);
    const Unmarked = z.map(z.string(), z.string()).and(z.map(z.string(), z.string()));
    expect(redact(Unmarked, new Map([["[pii]", "kept"]])).get("[pii]")).toBe("kept");
  });

  test("masks a transform's output whole when its input carries a mark, whatever shape it returns", () => {
    class Account {
      constructor(
        readonly email: string,
        readonly id: string,
      ) {}
    }
    const Instance = z.object({ e: pii(z.string()), id: z.string() }).transform((o) => new Account(o.e, o.id));
    expect(redact(Instance, Instance.parse({ e: "S-1", id: "i" }))).toBe("[pii]");
    const Copied = z.array(z.object({ e: pii(z.string()) }).transform((o) => ({ ...o, f: o.e })));
    expect(redact(Copied, Copied.parse([{ e: "S-1" }]))).toEqual(["[pii]"]);
    const Renamed = z.object({ e: pii(z.string()) }).pipe(z.transform((o) => ({ f: o.e })));
    expect(redact(Renamed, Renamed.parse({ e: "S-1" }))).toBe("[pii]");
    // A chain of transforms is as opaque as one, and a later schema over it does not undo that.
    const Chained = z
      .object({ e: pii(z.string()) })
      .transform((o) => ({ f: String(o.e) }))
      .pipe(z.object({ f: z.string() }));
    expect(redact(Chained, Chained.parse({ e: "S-1" }))).toBe("[pii]");
    // The strongest class the input carries masks it.
    const Mixed = z.object({ e: pii(z.string()), t: secret(z.string()) }).transform((o) => ({ ...o }));
    expect(redact(Mixed, Mixed.parse({ e: "S-1", t: "S-2" }))).toBe("[secret]");
    // A transform over an unmarked input is left as it was.
    const Plain = z.object({ n: z.string() }).transform((o) => ({ m: o.n }));
    expect(redact(Plain, Plain.parse({ n: "x" }))).toEqual({ m: "x" });
    expect(classifyPrivacy(Instance)).toEqual([
      { path: "", class: "pii" },
      { path: "e", class: "pii" },
    ]);
  });

  test("masks a class instance or a date whole where a branch that reaches it carries a mark", () => {
    class Account {
      constructor(readonly email: string) {}
    }
    const Either = z.union([z.object({ e: pii(z.string()) }), z.instanceof(Account)]);
    expect(redact(Either, new Account("S-1"))).toBe("[pii]");
    const Dated = z.union([z.object({ e: pii(z.string()) }), z.date()]);
    expect(redact(Dated, new Date(0))).toBe("[pii]");
    // An unmarked branch leaves its own value alone.
    const Kept = z.object({ at: z.date(), e: pii(z.string()) });
    expect(redact(Kept, Kept.parse({ at: new Date(0), e: "S-1" }))).toEqual({
      at: new Date(0),
      e: "[pii]",
    });
  });

  test("keeps every element of a set whose masked elements would collide", () => {
    const Emails = z.set(pii(z.string()));
    const masked = redact(Emails, Emails.parse(new Set(["S-1", "S-2"])));
    expect(masked.size).toBe(2);
    expect([...masked]).toEqual(["[pii]", "[pii] #2"]);
    const Mixed = z.set(z.union([pii(z.email()), z.string()]));
    const mixed = redact(Mixed, Mixed.parse(new Set(["a@b.co", "[pii]", "c@d.co"])));
    expect(mixed.size).toBe(3);
    expect([...mixed].some((item) => String(item).includes("@"))).toBe(false);
  });

  test("redacts a map's object key by its key schema, field by field", () => {
    const ByOwner = z.map(z.object({ e: pii(z.string()), id: z.string() }), z.string());
    const map = redact(ByOwner, ByOwner.parse(new Map([[{ e: "S-k", id: "i" }, "v"]])));
    expect([...map]).toEqual([[{ e: "[pii]", id: "i" }, "v"]]);
  });
});

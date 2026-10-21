// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { describe, expect, test } from "vitest";
import { z } from "zod";
import { SQLiteBoolean, SQLiteDate, sqliteJson } from "../data/codecs";
import { LogRecord, serializeRecord } from "../logger/record";
import { definePrivacyClass, pci, phi, pii, secret } from "./classes";
import { classifyPrivacy, MAX_RECURSION_DEPTH } from "./classify";
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

/** A recursion that passes sixteen nested objects a level, and a value of it `n` levels deep. */
const WIDTH = 16;
const Wide: z.ZodType = (() => {
  const self: { node?: z.ZodType } = {};
  let level: z.ZodType = z.object({
    id: z.number(),
    get next() {
      return (self.node as z.ZodType).optional();
    },
  });
  for (let index = 1; index < WIDTH; index += 1) level = z.object({ w: level });
  self.node = level;
  return level;
})();
function wide(n: number): unknown {
  let value: unknown = n === 0 ? { id: 0 } : { id: n, next: wide(n - 1) };
  for (let index = 1; index < WIDTH; index += 1) value = { w: value };
  return value;
}
/** One level down a {@link wide} value: through its sixteen objects to the next level. */
function down(at: object): unknown {
  let inner: unknown = at;
  for (let index = 1; index < WIDTH; index += 1) inner = (inner as { w: unknown }).w;
  return typeof inner === "object" && inner !== null ? (inner as { next?: unknown }).next : inner;
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

describe("the contract's edges", () => {
  test("masks a position two classes reach with the stronger one's placeholder, never one class's own mask", () => {
    const Id = z.union([z.object({ n: pci(z.string()) }), z.object({ n: pii(z.string()) })]);
    expect(masked(Id, { n: "4111111111111111" })).toEqual({ n: "[pci]" });
  });

  test("masks a scalar a fallback handed back where only an object is named, and keeps one a scalar option holds", () => {
    // biome-ignore lint/suspicious/noExplicitAny: a fallback that hands back the raw input, as one with a cast can.
    const back = (ctx: { input: unknown }): any => ctx.input;
    const Caught = z.object({ email: pii(z.string()) }).catch(back);
    expect(masked(Caught, "S-1")).toBe("[pii]");
    expect(masked(Caught, ["S-1"])).toBe("[pii]");
    expect(masked(z.object({ u: Caught }), { u: new Map([["email", "S-1"]]) })).toEqual({ u: "[pii]" });
    const at = new Date(0);
    expect(masked(z.union([z.string(), z.object({ e: pii(z.string()) })]), "hello")).toBe("hello");
    expect(masked(z.union([z.date(), z.object({ e: pii(z.string()) })]), at)).toBe(at);
  });

  test("keeps a record's symbol keys, numbers a set's masked elements apart, and redacts a map's object keys", () => {
    const tag = Symbol("tag");
    expect(masked(z.record(z.symbol(), z.object({ e: pii(z.string()) })), { [tag]: { e: "S-1" } })).toEqual({
      [tag]: { e: "[pii]" },
    });
    const tags = redact(z.set(pii(z.string())), new Set(["S-1", "S-2", "S-3"]) as never);
    expect([...tags]).toEqual(["[pii]", "[pii] #2", "[pii] #3"]);
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

  test("masks a value nested past the recursion limit as secret, with every level above it masked, and never throws", () => {
    const Item = z.object({
      e: pii(z.string()),
      get next() {
        return Item.optional();
      },
    });
    type Link = { e: string; next?: Link };
    let list: Link = { e: "S-last" };
    for (let index = 0; index < 5_000; index += 1) list = { e: `S-${index}`, next: list };
    const out = redact(Item, list as never) as Link | string;
    expect(raw(out)).toEqual([]);
    let depth = 0;
    let at: Link | string | undefined = out;
    while (typeof at === "object") {
      expect(at.e).toBe("[pii]");
      at = at.next as Link | string | undefined;
      depth += 1;
    }
    expect(at).toBe("[secret]");
    // The first level is where the recursion starts; each one after it comes round to it again.
    expect(depth).toBe(MAX_RECURSION_DEPTH + 1);
  });

  test("bounds a recursion by each position it returns to, however many positions one level passes", () => {
    type Kept = { id: number; children?: unknown };
    /** How many levels down the first child chain keep their shape, and what the chain ends in. */
    const levels = (out: unknown, next: (at: Kept) => unknown): [number, unknown] => {
      let count = 0;
      let at = out;
      while (typeof at === "object" && at !== null) {
        count += 1;
        at = next(at as Kept);
      }
      return [count, at];
    };
    // One object and one array a level, through a getter.
    const Tree = z.object({
      id: z.number(),
      get children() {
        return z.array(Tree);
      },
    });
    type TreeValue = { id: number; children: TreeValue[] };
    const tree = (n: number): TreeValue => ({ id: n, children: n === 0 ? [] : [tree(n - 1)] });
    const first = (at: Kept) => (at.children as unknown[] | string | undefined)?.[0];
    expect(levels(redact(Tree, tree(200) as never), first)).toEqual([201, undefined]);
    expect(levels(redact(Tree, tree(400) as never), first)).toEqual([MAX_RECURSION_DEPTH + 1, "[secret]"]);
    // Three positions a level: the object, its array, and the edge object the array holds.
    const Graph = z.object({
      id: z.number(),
      children: z.array(
        z.object({
          weight: z.number(),
          get node() {
            return Graph;
          },
        }),
      ),
    });
    type GraphValue = { id: number; children: { weight: number; node: GraphValue }[] };
    const graph = (n: number): GraphValue => ({
      id: n,
      children: n === 0 ? [] : [{ weight: 1, node: graph(n - 1) }],
    });
    const through = (at: Kept) => {
      const edge = (at.children as { node: unknown }[] | string | undefined)?.[0];
      return typeof edge === "object" ? edge.node : edge;
    };
    expect(levels(redact(Graph, graph(200) as never), through)).toEqual([201, undefined]);
    expect(levels(redact(Graph, graph(400) as never), through)).toEqual([MAX_RECURSION_DEPTH + 1, "[secret]"]);
    // Sixteen positions a level, so the walk is thousands of positions deep: it keeps its own stack, and never throws.
    expect(levels(redact(Wide, wide(400) as never), down)).toEqual([MAX_RECURSION_DEPTH + 1, "[secret]"]);
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
  test("a getter that builds a new schema at every level without end is masked whole, and never leaks once parsed", () => {
    const make = (): z.ZodType =>
      z.object({
        e: pii(z.string()),
        get next() {
          return make().optional();
        },
      });
    const Root = make();
    // Its insides never end, so the search beneath `next` runs to the recursion limit and assumes the strongest class.
    expect(classifyPrivacy(Root)).toEqual([
      { path: "e", class: "pii" },
      { path: "next", class: "pii" },
      { path: "next", class: "secret", truncated: true },
    ]);
    expect(redact(Root, { e: "S-1", next: { e: "S-2" } } as never)).toEqual({ e: "[pii]", next: "[secret]" });
    // Read by `parse` first, which freezes each shape it reads: the same answer, masked whole at the same position.
    const Parsed = make();
    const value = Parsed.parse({ e: "S-1", next: { e: "S-2", next: { e: "S-3" } } });
    expect(redact(Parsed, value as never)).toEqual({ e: "[pii]", next: "[secret]" });
    expect(classifyPrivacy(Parsed)).toEqual(classifyPrivacy(Root));
  });

  test("an endless build held by a plain field is masked whole where it starts to repeat, whoever read it first", () => {
    const make = (): z.ZodType =>
      z.object({
        e: pii(z.string()),
        get next() {
          return make().optional();
        },
      });
    const deep = (n: number): unknown => (n === 0 ? { e: "S-0" } : { e: `S-${n}`, next: deep(n - 1) });
    const value = { id: "P-1", n: deep(4) };
    const expected = { id: "P-1", n: { e: "[pii]", next: "[secret]" } };
    const listed = [
      { path: "n.e", class: "pii" },
      { path: "n.next", class: "pii" },
      { path: "n.next", class: "secret", truncated: true },
    ];
    const Fresh = z.object({ id: z.string(), n: make() });
    expect(redact(Fresh, value as never)).toEqual(expected);
    expect(classifyPrivacy(Fresh)).toEqual(listed);
    const Parsed = z.object({ id: z.string(), n: make() });
    Parsed.parse(value);
    expect(redact(Parsed, value as never)).toEqual(expected);
    expect(classifyPrivacy(Parsed)).toEqual(listed);
    // Two builders that build each other: the build repeats every second level, and is masked whole where it starts.
    const makeA = (): z.ZodType =>
      z.object({
        a: pii(z.string()),
        get b() {
          return makeB().optional();
        },
      });
    const makeB = (): z.ZodType =>
      z.object({
        k: z.string(),
        get a() {
          return makeA();
        },
      });
    const mutual = { a: "S-1", b: { k: "P-1", a: { a: "S-2", b: { k: "P-2", a: { a: "S-3" } } } } };
    const FreshA = makeA();
    const ParsedA = makeA();
    ParsedA.parse(mutual);
    expect(redact(FreshA, mutual as never)).toEqual({ a: "[pii]", b: "[secret]" });
    expect(redact(ParsedA, mutual as never)).toEqual({ a: "[pii]", b: "[secret]" });
  });

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
    // A transform on an intersection's side that copies a marked field the other side names: the copy's key is one
    // no schema names, at a position that carries the mark, so it is masked.
    const Side = z.intersection(
      z.object({ e: pii(z.string()) }),
      z.object({ e: z.string() }).transform((v) => ({ copied: v.e })),
    );
    const side = masked(Side, { e: "S-1" });
    expect(raw(side)).toEqual([]);
    expect(side).toEqual({ e: "[pii]", copied: "[pii]" });
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
    // An unknown option beside a marked object: a key only the unknown could have put there is masked, not kept raw.
    const Either = z.union([z.object({ e: pii(z.string()) }), z.unknown()]);
    expect(masked(Either, { leak: "S-1" })).toEqual({ leak: "[pii]" });
  });

  test("a lazy built anew at every level is masked whole as secret past the limit, and two a level end as fast", () => {
    const make = (): z.ZodType => z.lazy(() => z.object({ e: pii(z.string()), next: make().optional() }));
    const Chain = make();
    expect(classifyPrivacy(Chain)).toEqual([
      { path: "", class: "pii" },
      { path: "", class: "secret", truncated: true },
    ]);
    expect(redact(Chain, { e: "S-1" } as never)).toBe("[secret]");
    const wide = (): z.ZodType => z.lazy(() => z.object({ a: wide().optional(), b: wide().optional() }));
    const started = Date.now();
    expect(classifyPrivacy(z.object({ id: z.string(), tree: wide() }))).toEqual([
      { path: "tree", class: "secret", truncated: true },
    ]);
    expect(Date.now() - started).toBeLessThan(2_000);
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

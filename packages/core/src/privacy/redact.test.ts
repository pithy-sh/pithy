// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { describe, expect, test } from "vitest";
import { z } from "zod";
import { SQLiteDate, sqliteJson } from "../data/codecs";
import { LogRecord, serializeRecord } from "../logger/record";
import { definePrivacyClass, pci, phi, pii, secret } from "./classes";
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

  test("applies every union option the value parses as, so a looser option cannot let a marked key through", () => {
    const Basic = z.object({ id: z.string() });
    const Full = z.object({ id: z.string(), email: pii(z.string()) });
    const U = z.union([Basic, Full]).describe("Either.");
    expect(redact(U, { id: "u1", email: "a@b.c" } as never)).toEqual({ id: "u1", email: "[pii]" });
    const Prim = z.union([z.string(), pii(z.number())]).describe("A string or a marked number.");
    expect(redact(Prim, "plain")).toBe("plain");
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

  test("keeps a nested key any option a union value parses as names", () => {
    const U = z.union([
      z.object({ p: z.object({ x: z.string() }) }),
      z.object({ p: z.object({ y: pii(z.string()) }) }),
    ]);
    const value = { p: { x: "kept", y: "a@b.c", z: "dropped" } };
    expect(redact(U, value as never)).toEqual({ p: { x: "kept", y: "[pii]" } });
  });

  test("drops a key only an option the value does not parse as names, so no side copies it raw", () => {
    const Left = z.union([z.object({ b: pii(z.string()), z: z.number() }), z.object({ c: z.string() })]);
    const Right = z.union([z.object({ b: pii(z.string()), z: z.number() }), z.object({ d: z.string() })]);
    const Both = z.intersection(Left, Right);
    expect(redact(Both, { b: "a@b.c", c: "c", d: "d" } as never)).toEqual({ c: "c", d: "d" });
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
});

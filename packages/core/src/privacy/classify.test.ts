// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { describe, expect, test } from "vitest";
import { z } from "zod";
import { SQLiteBoolean, SQLiteDate, sqliteJson } from "../data/codecs";
import { definePrivacyClass, pci, phi, pii, secret } from "./classes";
import { classifyPrivacy, hasPrivacy, privacyOf } from "./classify";
import { redact } from "./redact";

const Address = z
  .object({
    line1: pii(z.string().describe("The street line.")),
    country: z.string().describe("The ISO country code."),
  })
  .describe("A postal address.");

/** A marked string. A brand is on the output type, so a default is a parsed (branded) value. */
const Plan = pii(z.string().describe("A plan name."));

const User = z
  .object({
    id: z.string().describe("The user's stable id."),
    email: pii(z.string().describe("The address sign-in links are sent to.")),
    diagnosis: phi(z.string().describe("The recorded condition.")).optional(),
    nickname: pii(z.string()).nullable().describe("What friends call them."),
    plan: Plan.default(Plan.parse("free")).describe("A plan name, marked to prove `.default()` is read through."),
    address: Address.optional().describe("Where they live."),
    devices: z
      .array(
        z
          .object({ token: secret(z.string().describe("A push token.")), label: z.string().describe("A label.") })
          .describe("One device."),
      )
      .describe("Every device."),
  })
  .describe("A user.");

describe("privacyOf", () => {
  test("reads a marker through optional, nullable and default", () => {
    expect(privacyOf(pii(z.string()).optional())).toBe("pii");
    expect(privacyOf(pii(z.string()).nullable())).toBe("pii");
    expect(privacyOf(Plan.default(Plan.parse("x")))).toBe("pii");
    expect(privacyOf(pii(z.string().default("x")))).toBe("pii");
    expect(privacyOf(pii(z.string()).optional().nullable().describe("x"))).toBe("pii");
  });

  test("reads a marker applied outside a wrapper", () => {
    expect(privacyOf(pii(z.string().optional()))).toBe("pii");
  });

  test("is null for an unmarked schema", () => {
    expect(privacyOf(z.string().optional())).toBeNull();
  });
});

describe("classifyPrivacy", () => {
  test("returns every marked path with its class, nested paths included", () => {
    expect(classifyPrivacy(User)).toEqual([
      { path: "email", class: "pii" },
      { path: "diagnosis", class: "phi" },
      { path: "nickname", class: "pii" },
      { path: "plan", class: "pii" },
      { path: "address.line1", class: "pii" },
      { path: "devices[].token", class: "secret" },
    ]);
  });

  test("is empty for a schema with no markers", () => {
    expect(classifyPrivacy(z.object({ id: z.string().describe("id") }).describe("x"))).toEqual([]);
  });

  test("names a marked root by the empty path", () => {
    expect(classifyPrivacy(pci(z.string()))).toEqual([{ path: "", class: "pci" }]);
  });

  test("reads markers on codec fields, and lists a JSON column's marked fields one by one", () => {
    const Profile = z.object({ phone: pii(z.string().describe("A phone number.")) }).describe("A profile.");
    const Row = z
      .object({
        bornAt: pii(SQLiteDate).describe("Date of birth."),
        smoker: phi(SQLiteBoolean).describe("Whether they smoke."),
        profile: sqliteJson(Profile).describe("The profile, as JSON."),
      })
      .describe("A row.");
    // `sqliteJson` is the kit's own codec, so the walk reads through it to the schema it decodes to.
    expect(classifyPrivacy(Row)).toEqual([
      { path: "bornAt", class: "pii" },
      { path: "smoker", class: "phi" },
      { path: "profile.phone", class: "pii" },
    ]);
  });

  test("walks unions, records and tuples", () => {
    const Shape = z
      .object({
        contact: z
          .union([
            z.object({ kind: z.literal("email"), email: pii(z.string()) }),
            z.object({ kind: z.literal("phone"), phone: pii(z.string()) }),
          ])
          .describe("One contact."),
        notes: z.record(z.string(), phi(z.string())).describe("Notes by key."),
        pair: z.tuple([z.string(), secret(z.string())]).describe("A pair."),
      })
      .describe("A shape.");
    expect(classifyPrivacy(Shape)).toEqual([
      { path: "contact.email", class: "pii" },
      { path: "contact.phone", class: "pii" },
      { path: "notes.*", class: "phi" },
      { path: "pair[1]", class: "secret" },
    ]);
  });

  test("follows a lazy schema, and returns on a recursive one", () => {
    type Node = { name: string; children: Node[] };
    const Node: z.ZodType<Node> = z.lazy(() =>
      z.object({ name: pii(z.string()), children: z.array(Node) }),
    ) as z.ZodType<Node>;
    expect(classifyPrivacy(z.object({ root: Node }).describe("t"))).toEqual([{ path: "root.name", class: "pii" }]);
    expect(classifyPrivacy(Node)).toEqual([{ path: "name", class: "pii" }]);
  });

  test("finds a marker that lives only behind a lazy, so hasPrivacy sees it at any depth", () => {
    type Entry = { id: string; note: string; children: Entry[] };
    const Entry: z.ZodType<Entry> = z.lazy(() =>
      z.object({ id: z.string(), note: z.lazy(() => phi(z.string())), children: z.array(Entry) }),
    ) as z.ZodType<Entry>;
    expect(classifyPrivacy(Entry)).toEqual([{ path: "note", class: "phi" }]);
    expect(hasPrivacy(Entry, "phi")).toBe(true);
  });

  test("names a marked record or map key by `<key>`, and a map's value by `*`", () => {
    const Shape = z.object({
      byEmail: z.record(pii(z.string()), z.number()),
      byPhone: z.map(pii(z.string()), phi(z.string())),
    });
    expect(classifyPrivacy(Shape)).toEqual([
      { path: "byEmail.<key>", class: "pii" },
      { path: "byPhone.<key>", class: "pii" },
      { path: "byPhone.*", class: "phi" },
    ]);
  });

  test("names a marked catchall by `*`", () => {
    expect(classifyPrivacy(z.object({ id: z.string() }).catchall(pii(z.string())))).toEqual([
      { path: "*", class: "pii" },
    ]);
  });

  test("returns on a recursive schema written with a getter", () => {
    const Category = z.object({
      label: pii(z.string()),
      get children() {
        return z.array(Category);
      },
    });
    expect(classifyPrivacy(Category)).toEqual([{ path: "label", class: "pii" }]);
  });

  test("classifies an adopter-registered class like a built-in", () => {
    const genetic = definePrivacyClass({ name: "genetic_classify" });
    expect(classifyPrivacy(z.object({ marker: genetic(z.string()) }).describe("x"))).toEqual([
      { path: "marker", class: "genetic_classify" },
    ]);
  });

  test("lists a field an intersection narrows so it can never hold the marked type: more than redact masks, never less", () => {
    // The left side narrows `b` to a number, so the right side's marked string option can never apply. The inventory
    // does not reason about narrowing: it lists `b` as `pii`, and `redact` keeps every value parse lets through.
    const Narrowed = z.intersection(
      z.object({ b: z.number() }),
      z.object({ b: z.union([pii(z.string()), z.number()]) }),
    );
    expect(Narrowed.safeParse({ b: "x" }).success).toBe(false);
    expect(classifyPrivacy(Narrowed)).toEqual([{ path: "b", class: "pii" }]);
    expect(hasPrivacy(Narrowed, "pii")).toBe(true);
    expect(redact(Narrowed, Narrowed.parse({ b: 3 }))).toEqual({ b: 3 });
  });

  test("a marked container carries every class marked inside it, and the strongest is its placeholder", () => {
    const Row = z
      .object({
        profile: pii(
          z
            .object({
              diagnosis: phi(z.string().describe("A condition.")),
              token: secret(z.string().describe("A token.")),
            })
            .describe("A profile."),
        ),
      })
      .describe("A row.");
    expect(classifyPrivacy(Row)).toEqual([
      { path: "profile", class: "pii" },
      { path: "profile", class: "phi" },
      { path: "profile", class: "secret" },
    ]);
    expect(hasPrivacy(Row, "phi")).toBe(true);
    expect(hasPrivacy(Row, "secret")).toBe(true);
    expect(redact(Row, Row.parse({ profile: { diagnosis: "S-flu", token: "S-t" } }))).toEqual({ profile: "[secret]" });
    // The same object behind a transform, which is opaque, lists and masks alike.
    const Opaque = z
      .object({ profile: Row.shape.profile.transform((profile) => profile).describe("A profile.") })
      .describe("A row.");
    expect(redact(Opaque, Opaque.parse({ profile: { diagnosis: "S-flu", token: "S-t" } }))).toEqual({
      profile: "[secret]",
    });
  });

  test("a marked array and a marked record carry the classes marked in their elements", () => {
    const Row = z
      .object({
        notes: pii(z.array(phi(z.string().describe("A note."))).describe("Notes.")),
        byId: pii(z.record(z.string(), secret(z.string().describe("A token."))).describe("Tokens.")),
        plain: pii(z.object({ name: z.string().describe("A name.") }).describe("A plain one.")),
      })
      .describe("A row.");
    expect(classifyPrivacy(Row)).toEqual([
      { path: "notes", class: "pii" },
      { path: "notes", class: "phi" },
      { path: "byId", class: "pii" },
      { path: "byId", class: "secret" },
      { path: "plain", class: "pii" },
    ]);
    expect(redact(Row, Row.parse({ notes: ["S-a"], byId: { a: "S-b" }, plain: { name: "S-c" } }))).toEqual({
      notes: "[phi]",
      byId: "[secret]",
      plain: "[pii]",
    });
  });
});

describe("hasPrivacy", () => {
  test("is true for a class at any depth and false otherwise", () => {
    expect(hasPrivacy(User, "phi")).toBe(true);
    expect(hasPrivacy(User, "secret")).toBe(true);
    expect(hasPrivacy(User, "pci")).toBe(false);
    expect(hasPrivacy(z.object({ id: z.string() }), "pii")).toBe(false);
  });
});

describe("each call keeps nothing for the next", () => {
  test("a class registered after a read that met a throw is listed by the next call", () => {
    let marker: ((schema: z.ZodString) => z.ZodType) | undefined;
    const Row = z.object({
      id: z.string(),
      get g() {
        if (!marker) throw new Error("not yet");
        return marker(z.string());
      },
    });
    // The getter throws: the field cannot be read, so every class registered so far is assumed there.
    const first = classifyPrivacy(Row);
    expect(first.every((field) => field.truncated)).toBe(true);
    expect(first.some((field) => field.class === "genome_cache")).toBe(false);
    marker = definePrivacyClass({ name: "genome_cache" });
    expect(classifyPrivacy(Row)).toContainEqual({ path: "g", class: "genome_cache" });
    expect(hasPrivacy(Row, "genome_cache")).toBe(true);
  });
});

// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { describe, expect, test } from "vitest";
import { z } from "zod";
import { SQLiteBoolean, SQLiteDate, sqliteJson } from "../data/codecs";
import { definePrivacyClass, pci, phi, pii, secret } from "./classes";
import { classifyPrivacy, hasPrivacy, privacyOf } from "./classify";

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

  test("reads markers on codec fields and inside a JSON column", () => {
    const Profile = z.object({ phone: pii(z.string().describe("A phone number.")) }).describe("A profile.");
    const Row = z
      .object({
        bornAt: pii(SQLiteDate).describe("Date of birth."),
        smoker: phi(SQLiteBoolean).describe("Whether they smoke."),
        profile: sqliteJson(Profile).describe("The profile, as JSON."),
      })
      .describe("A row.");
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

  test("names a marked record or map key by `<key>`", () => {
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
});

describe("hasPrivacy", () => {
  test("is true for a class at any depth and false otherwise", () => {
    expect(hasPrivacy(User, "phi")).toBe(true);
    expect(hasPrivacy(User, "secret")).toBe(true);
    expect(hasPrivacy(User, "pci")).toBe(false);
    expect(hasPrivacy(z.object({ id: z.string() }), "pii")).toBe(false);
  });
});

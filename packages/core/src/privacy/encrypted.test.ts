// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { describe, expect, test } from "vitest";
import { z } from "zod";
import { EncryptedEnvelope } from "../crypto/envelope";
import { sqliteJson } from "../data/codecs";
import { ValidationError } from "../error/pithyError";
import type { Logger } from "../logger/logger";
import { phi, pii } from "./classes";
import { classifyPrivacy } from "./classify";
import {
  BLIND_INDEX_NORMALIZERS,
  blindIndex,
  blindIndexOf,
  encrypted,
  encryptedLayout,
  encryptedSpecOf,
  encryptedTable,
  encryptedTableOf,
  normalizeForIndex,
  sqlIdentifier,
} from "./encrypted";
import { redact } from "./redact";
import type { Opened } from "./sealed";
import type { Redacted } from "./types";

/** A stored column, which the row type admits as either side of its codec, read as the JSON it is. */
function stored(value: unknown): { readonly [key: string]: unknown; readonly keyVersion: number } {
  return JSON.parse(value as string);
}

const envelope = { encryptedValue: "Y2lwaGVy", iv: "aXZpdml2aXZpdml2", keyVersion: 1 };

const Patient = encryptedTable(
  z
    .object({
      id: z.string().describe("The patient's stable id, assigned by the app before the insert."),
      diagnosis: encrypted(phi(z.string().describe("The recorded condition."))),
      email: encrypted(pii(z.string().describe("Where we write.")), { index: "email" }),
      emailIndex: blindIndex("email"),
      notes: encrypted(z.string().describe("Free text the clinician wrote.")).nullable(),
    })
    .describe("A patient."),
  { name: "patient", key: "id" },
);

describe("encrypted()", () => {
  test("the codec is synchronous: the stored side is the envelope's JSON, the parsed side the envelope", () => {
    const row = {
      id: "p_1",
      diagnosis: JSON.stringify(envelope),
      email: JSON.stringify(envelope),
      emailIndex: `1:${"a".repeat(43)}`,
      notes: null,
    };
    const parsed = Patient.parse(row);
    expect(parsed.diagnosis).toEqual(envelope);
    expect(Patient.encode(parsed)).toEqual(row);
  });

  test("Schema.encode handed plaintext where an envelope belongs fails validation", () => {
    const plaintext = {
      id: "p_1",
      diagnosis: "asthma",
      email: envelope,
      emailIndex: `1:${"a".repeat(43)}`,
      notes: null,
    };
    expect(Patient.safeEncode(plaintext as never).success).toBe(false);
    // And a column holding plaintext does not parse as one.
    expect(Patient.safeParse({ ...plaintext, diagnosis: "asthma", email: JSON.stringify(envelope) }).success).toBe(
      false,
    );
  });

  test("a null optional field is SQL NULL, and a present one an envelope", () => {
    const row = Patient.encode({
      id: "p_1",
      diagnosis: envelope,
      email: envelope,
      emailIndex: `1:${"a".repeat(43)}`,
      notes: null,
    } as never);
    expect(row.notes).toBeNull();
    expect(stored(row.diagnosis)).toEqual(envelope);
  });

  test("keeps the class it was handed, so the inventory lists it and redact masks it", () => {
    expect(classifyPrivacy(Patient)).toEqual([
      { path: "diagnosis", class: "phi" },
      { path: "email", class: "pii" },
    ]);
    const parsed = Patient.parse({
      id: "p_1",
      diagnosis: JSON.stringify(envelope),
      email: JSON.stringify(envelope),
      emailIndex: `1:${"a".repeat(43)}`,
      notes: null,
    });
    const masked: Redacted<typeof Patient> = redact(Patient, parsed);
    expect(masked.diagnosis).toBe("[phi]");
    expect(masked.email).toBe("[pii]");
  });

  test("carries every class marked inside an object it seals", () => {
    const Field = encrypted(
      z.object({ a: pii(z.string().describe("A.")), b: phi(z.string().describe("B.")) }).describe("Both."),
    );
    expect(classifyPrivacy(Field).map((one) => one.class)).toEqual(["phi", "pii"]);
  });

  test("an encrypted field with no class is listed by nobody and still encrypted", () => {
    const Field = encrypted(z.string().describe("Plain."));
    expect(classifyPrivacy(Field)).toEqual([]);
    expect(encryptedSpecOf(Field)?.index).toBeNull();
  });

  test("survives a describe, a meta and a marker over it, and is found through its wrappers", () => {
    const Field = encrypted(z.string().describe("x"), { index: "exact" });
    expect(encryptedSpecOf(Field.describe("y"))?.index).toBe("exact");
    expect(encryptedSpecOf(phi(Field))?.index).toBe("exact");
    expect(encryptedSpecOf(Field.optional().nullable())?.index).toBe("exact");
    expect(encryptedSpecOf(sqliteJson(EncryptedEnvelope))).toBeUndefined();
  });

  test("refuses presence inside the marker, a second marker, and a normalizer that is not the kit's", () => {
    expect(() => encrypted(z.string().optional())).toThrow(ValidationError);
    expect(() => encrypted(z.string().nullable())).toThrow(ValidationError);
    expect(() => encrypted(encrypted(z.string()))).toThrow(ValidationError);
    expect(() => encrypted(z.string(), { index: "soundex" as never })).toThrow(ValidationError);
    expect(BLIND_INDEX_NORMALIZERS).toEqual(["exact", "email"]);
  });

  test("an encrypted phi value is still refused by the log gate, as an envelope and as the plaintext", () => {
    const compileOnly = (log: Logger, parsed: z.output<typeof Patient>, opened: Opened<typeof Patient>) => {
      // @ts-expect-error the envelope carries the field's class
      log.info("read", { diagnosis: parsed.diagnosis });
      // @ts-expect-error and so does the plaintext the seam opens it to
      log.info("read", { diagnosis: opened.diagnosis });
      // An unmarked encrypted field's plaintext is an ordinary string, and the key is too.
      log.info("read", { id: opened.id });
      const notes: string | null = opened.notes;
      void notes;
    };
    expect(typeof compileOnly).toBe("function");
  });
});

describe("blindIndex()", () => {
  test("names the field it indexes and holds `<version>:<hmac>`", () => {
    const column = blindIndex("email");
    expect(blindIndexOf(column.nullable())).toBe("email");
    expect(column.safeParse(`12:${"A".repeat(43)}`).success).toBe(true);
    expect(column.safeParse("ada@example.com").success).toBe(false);
    expect(column.description).toContain("email");
  });

  test("the normalizers are the kit's: exact as written, email NFC, trimmed, lowercased", () => {
    expect(normalizeForIndex("exact", " Ada ")).toBe(" Ada ");
    expect(normalizeForIndex("email", " Ada@Example.COM ")).toBe("ada@example.com");
    expect(normalizeForIndex("email", "é@x.com")).toBe("é@x.com");
  });
});

describe("encryptedTable()", () => {
  test("records the AAD name and the primary-key field on the schema", () => {
    expect(encryptedTableOf(Patient)).toEqual({ name: "patient", key: "id" });
    expect(encryptedTableOf(Patient.describe("again"))).toEqual({ name: "patient", key: "id" });
    expect(Patient.description).toBe("A patient.");
  });

  test("refuses an auto-increment integer key, a missing key, an encrypted key and a name with a colon", () => {
    const base = { diagnosis: encrypted(z.string().describe("x")) };
    expect(() =>
      encryptedTable(z.object({ id: z.number().int().describe("id"), ...base }), { name: "t", key: "id" }),
    ).toThrow(/integer/);
    expect(() => encryptedTable(z.object({ ...base }), { name: "t", key: "id" })).toThrow(ValidationError);
    expect(() => encryptedTable(z.object({ id: encrypted(z.string()) }), { name: "t", key: "id" })).toThrow(
      ValidationError,
    );
    expect(() => encryptedTable(z.object({ id: z.string().optional() }), { name: "t", key: "id" })).toThrow(
      ValidationError,
    );
    expect(() => encryptedTable(z.object({ id: z.string() }), { name: "a:b", key: "id" })).toThrow(ValidationError);
    expect(() => encryptedTable(z.string() as never, { name: "t", key: "id" })).toThrow(ValidationError);
  });
});

describe("encryptedLayout()", () => {
  test("locates a column, a key inside a JSON column, and pairs each index", () => {
    const Visit = encryptedTable(
      z.object({
        id: z.string(),
        email: encrypted(z.string(), { index: "email" }),
        emailIndex: blindIndex("email").nullable(),
        profile: sqliteJson(z.object({ phone: encrypted(z.string()).optional(), city: z.string() })),
      }),
      { name: "visit", key: "id" },
    );
    const layout = encryptedLayout(Visit);
    expect(layout.problems).toEqual([]);
    expect(layout.fields.map((field) => [field.path, field.indexField])).toEqual([
      ["email", "emailIndex"],
      ["profile.phone", null],
    ]);
  });

  test("names every way a table cannot be sealed or rotated", () => {
    const Bad = z.object({
      id: z.string(),
      orphan: blindIndex("missing"),
      email: encrypted(z.string(), { index: "exact" }),
      list: z.array(encrypted(z.string())),
      json: sqliteJson(z.object({ deep: encrypted(z.string(), { index: "exact" }) })),
    });
    const problems = encryptedLayout(Bad).problems.join("\n");
    expect(problems).toContain('no blindIndex("email") column');
    expect(problems).toContain('under "list"');
    expect(problems).toContain('"json.deep" declares a blind index inside a JSON column');
    expect(problems).toContain('"orphan" is blindIndex("missing")');
  });

  test("the SQL column is the plugin's own snake_case", () => {
    expect(sqlIdentifier("emailIndex")).toBe("email_index");
    expect(sqlIdentifier("diagnosis")).toBe("diagnosis");
  });
});

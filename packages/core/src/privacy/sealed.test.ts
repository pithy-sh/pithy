// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { describe, expect, test } from "vitest";
import { z } from "zod";
import { type EncryptionConfig, encryptValue } from "../crypto/envelope";
import { sqliteJson } from "../data/codecs";
import { PithyError, ValidationError } from "../error/pithyError";
import { blindIndexLabel, blindIndexValue } from "./blindIndex";
import { phi, pii } from "./classes";
import { blindIndex, encrypted, encryptedTable } from "./encrypted";
import { redact } from "./redact";
import { FIELD_CONTEXT_PREFIX, fieldContext, sealed } from "./sealed";

/** A stored column, which the row type admits as either side of its codec, read as the JSON it is. */
function stored(value: unknown): { readonly [key: string]: unknown; readonly keyVersion: number } {
  return JSON.parse(value as string);
}

function keyB64(): string {
  const key = crypto.getRandomValues(new Uint8Array(32));
  let binary = "";
  for (const byte of key) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function keys(current: number, versions: Record<string, string>): EncryptionConfig {
  return { currentVersion: String(current), versions, lastRotatedAt: "2026-10-01T00:00:00.000Z" };
}

const Patient = encryptedTable(
  z
    .object({
      id: z.string().describe("The patient's stable id, assigned by the app before the insert."),
      diagnosis: encrypted(phi(z.string().describe("The recorded condition."))),
      email: encrypted(pii(z.string().describe("Where we write.")), { index: "email" }),
      emailIndex: blindIndex("email"),
      notes: encrypted(z.string().describe("Free text.")).nullable(),
      profile: sqliteJson(
        z
          .object({
            phone: encrypted(pii(z.string().describe("A phone number."))).optional(),
            city: z.string().describe("Where they live."),
          })
          .describe("Profile."),
      ).describe("Profile, as JSON."),
      seenAt: encrypted(z.object({ at: z.iso.datetime().describe("When.") }).describe("A visit.")),
    })
    .describe("A patient."),
  { name: "patient", key: "id" },
);

const value = {
  id: "p_1",
  diagnosis: "asthma",
  email: "Ada@Example.com",
  notes: null,
  profile: { phone: "+1 555 0100", city: "Leeds" },
  seenAt: { at: "2026-10-22T10:00:00.000Z" },
} as never;

describe("sealed()", () => {
  test("seals on write and opens on read, round-tripping every marked field, a nested one at a JSON path included", async () => {
    const v1 = keys(1, { "1": keyB64() });
    const patients = sealed(Patient, { keys: v1 });
    const record = await patients.seal(value);

    // The row Kysely inserts: envelopes as JSON, no plaintext anywhere in it.
    const written = JSON.stringify(record);
    for (const plain of ["asthma", "Ada@Example.com", "555 0100", "2026-10-22"]) expect(written).not.toContain(plain);
    expect(stored(record.diagnosis).keyVersion).toBe(1);
    expect(stored(record.profile).city).toBe("Leeds");
    // A field inside a JSON column rests as its own envelope JSON, a string within the column's JSON.
    expect(stored(stored(record.profile).phone).keyVersion).toBe(1);
    expect(record.notes).toBeNull();
    expect(record.emailIndex).toMatch(/^1:/);

    expect(await patients.open(record)).toEqual({ ...(value as object), emailIndex: record.emailIndex });
  });

  test("reads the key from a binding or a .dev.vars string, and only once", async () => {
    const v1 = keys(1, { "1": keyB64() });
    let reads = 0;
    const patients = sealed(Patient, {
      keys: {
        get: async () => {
          reads += 1;
          return JSON.stringify(v1);
        },
      },
    });
    const record = await patients.seal(value);
    await patients.open(record);
    expect(reads).toBe(1);
    expect(await sealed(Patient, { keys: JSON.stringify(v1) }).open(record)).toMatchObject({ diagnosis: "asthma" });
  });

  test("an absent optional field rests absent, and its JSON path is not sealed", async () => {
    const patients = sealed(Patient, { keys: keys(1, { "1": keyB64() }) });
    const record = await patients.seal({ ...(value as object), profile: { city: "Leeds" } } as never);
    expect(stored(record.profile)).toEqual({ city: "Leeds" });
    expect((await patients.open(record)).profile).toEqual({ city: "Leeds" });
  });

  test("every write seals under the current version, and a row written after a rotation carries the new one", async () => {
    const k1 = keyB64();
    const before = await sealed(Patient, { keys: keys(1, { "1": k1 }) }).seal(value);
    const rotated = sealed(Patient, { keys: keys(2, { "1": k1, "2": keyB64() }) });
    const after = await rotated.seal(value);
    expect(stored(after.diagnosis).keyVersion).toBe(2);
    expect(after.emailIndex).toMatch(/^2:/);
    // The row sealed under the previous version still opens while that version is live.
    expect((await rotated.open(before)).diagnosis).toBe("asthma");
  });

  test("the opened value keeps its privacy brand: redact over the opened schema masks it", async () => {
    const patients = sealed(Patient, { keys: keys(1, { "1": keyB64() }) });
    const opened = await patients.open(await patients.seal(value));
    const masked = redact(patients.opened, opened) as Record<string, unknown>;
    expect(masked.diagnosis).toBe("[phi]");
    expect(masked.email).toBe("[pii]");
    expect(masked.id).toBe("p_1");
  });
});

describe("the AAD binds the declared name, the field path and the primary key", () => {
  test("is pithy/enc/1:<name>:<field path>:<pk>", () => {
    expect(FIELD_CONTEXT_PREFIX).toBe("pithy/enc/1");
    expect(fieldContext("patient", "profile.phone", "p_1")).toBe("pithy/enc/1:patient:profile.phone:p_1");
  });

  test("a ciphertext moved to another field does not open", async () => {
    const patients = sealed(Patient, { keys: keys(1, { "1": keyB64() }) });
    const record = await patients.seal(value);
    await expect(patients.open({ ...record, notes: record.diagnosis })).rejects.toBeInstanceOf(PithyError);
  });

  test("a ciphertext moved to another row does not open", async () => {
    const patients = sealed(Patient, { keys: keys(1, { "1": keyB64() }) });
    const a = await patients.seal(value);
    const b = await patients.seal({ ...(value as object), id: "p_2" } as never);
    await expect(patients.open({ ...b, diagnosis: a.diagnosis })).rejects.toBeInstanceOf(PithyError);
    await expect(patients.open({ ...a, id: "p_2" })).rejects.toBeInstanceOf(PithyError);
  });

  test("a ciphertext moved to a table of another declared name does not open", async () => {
    const config = keys(1, { "1": keyB64() });
    const record = await sealed(Patient, { keys: config }).seal(value);
    const Other = encryptedTable(Patient, { name: "visitor", key: "id" });
    await expect(sealed(Other, { keys: config }).open(record)).rejects.toBeInstanceOf(PithyError);
  });

  test("renaming the SQL table leaves rows openable: the AAD binds the declared name, not the table", async () => {
    // The declared name is all a seal reads of the table's identity, so a schema registered under another SQL table
    // name, with the same declaration, opens every row the old one sealed.
    const config = keys(1, { "1": keyB64() });
    const record = await sealed(Patient, { keys: config }).seal(value);
    const renamed = { pithy_patients_v2: Patient };
    expect((await sealed(renamed.pithy_patients_v2, { keys: config }).open(record)).diagnosis).toBe("asthma");
  });

  test("renaming an encrypted column changes its field path, so the old ciphertext does not open under the new one", async () => {
    const config = keys(1, { "1": keyB64() });
    const record = await sealed(Patient, { keys: config }).seal(value);
    const Renamed = encryptedTable(z.object({ id: z.string(), condition: encrypted(phi(z.string())) }), {
      name: "patient",
      key: "id",
    });
    await expect(
      sealed(Renamed, { keys: config }).open({ id: "p_1", condition: record.diagnosis }),
    ).rejects.toBeInstanceOf(PithyError);
  });

  test("a value sealed by hand under the documented context opens: the format is what the docs say", async () => {
    const config = keys(1, { "1": keyB64() });
    const envelope = await encryptValue(config, "pithy/enc/1:patient:diagnosis:p_1", JSON.stringify("asthma"));
    const record = await sealed(Patient, { keys: config }).seal(value);
    expect(
      (await sealed(Patient, { keys: config }).open({ ...record, diagnosis: JSON.stringify(envelope) })).diagnosis,
    ).toBe("asthma");
  });
});

describe("match()", () => {
  test("returns one hash per live version, newest first, and finds a row indexed under the previous version", async () => {
    const k1 = keyB64();
    const old = await sealed(Patient, { keys: keys(1, { "1": k1 }) }).seal(value);
    const rotated = sealed(Patient, { keys: keys(2, { "1": k1, "2": keyB64() }) });
    const hashes = await rotated.match("email", "  ada@EXAMPLE.com");
    expect(hashes).toHaveLength(2);
    expect(hashes[0]).toMatch(/^2:/);
    expect(hashes).toContain(old.emailIndex);
  });

  test("index values are <version>:<hmac> under a key labeled with the normalizer, so a changed normalizer misses", async () => {
    const config = keys(1, { "1": keyB64() });
    expect(blindIndexLabel("email")).toBe("pithy/blind-index/email");
    const asEmail = await blindIndexValue(config, 1, "email", "ada@example.com");
    const asExact = await blindIndexValue(config, 1, "exact", "ada@example.com");
    expect(asEmail).toMatch(/^1:[A-Za-z0-9_-]{43}$/);
    expect(asExact).not.toBe(asEmail);
  });

  test("refuses a field with no blind index", async () => {
    const patients = sealed(Patient, { keys: keys(1, { "1": keyB64() }) });
    await expect(patients.match("diagnosis" as never, "x")).rejects.toBeInstanceOf(ValidationError);
  });
});

describe("what sealed() refuses at build", () => {
  test("a schema with an encrypted field and no encryptedTable() declaration, naming the schema", () => {
    const Bare = z.object({ id: z.string(), secret: encrypted(z.string()) }).describe("An undeclared table.");
    expect(() => sealed(Bare, { keys: undefined })).toThrow(/An undeclared table.*declares no table/);
  });

  test("an indexed field with no blindIndex column, and an index column naming no indexed field", () => {
    const NoColumn = encryptedTable(z.object({ id: z.string(), email: encrypted(z.string(), { index: "email" }) }), {
      name: "a",
      key: "id",
    });
    expect(() => sealed(NoColumn, { keys: undefined })).toThrow(/no blindIndex\("email"\) column/);
    const NoField = encryptedTable(
      z.object({ id: z.string(), email: encrypted(z.string()), emailIndex: blindIndex("email") }),
      { name: "b", key: "id" },
    );
    expect(() => sealed(NoField, { keys: undefined })).toThrow(/no indexed encrypted field/);
  });

  test("a missing field key, on first use, without echoing anything", async () => {
    const patients = sealed(Patient, { keys: undefined });
    await expect(patients.seal(value)).rejects.toThrow(/no field key/);
    await expect(sealed(Patient, { keys: "{not json" }).seal(value)).rejects.toBeInstanceOf(PithyError);
  });

  test("a row with no primary key to bind", async () => {
    const patients = sealed(Patient, { keys: keys(1, { "1": keyB64() }) });
    await expect(patients.seal({ ...(value as object), id: "" } as never)).rejects.toThrow(/no id to bind/);
  });
});

// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { describe, expect, test } from "vitest";
import { z } from "zod";
import { type Capability, defineCapability } from "../capability/capability";
import { phi, pii, secret } from "./classes";
import { unreadClasses } from "./classify";
import { blindIndex, encrypted, encryptedTable } from "./encrypted";
import { lazyPrivacyInventory, privacyInventory } from "./inventory";
import { PRIVACY_SOURCES } from "./report";

const Patients = z
  .object({
    id: z.string().describe("id"),
    email: pii(z.string().describe("email")),
    diagnosis: phi(z.string().describe("diagnosis")),
  })
  .describe("patients");
const Notes = z.object({ id: z.string().describe("id"), body: z.string().describe("body") }).describe("notes");

function app(tables: Record<string, z.ZodType> = { patients: Patients, notes: Notes }): Capability {
  return defineCapability({
    name: "app",
    requiredBindings: [],
    databases: { app: { binding: "DB", tables } },
    kvNamespaces: {
      sessions: {
        binding: "SESSIONS",
        stores: {
          session: {
            prefix: "app",
            key: z.object({ email: pii(z.string()) }),
            value: z.object({ token: secret(z.string()), plan: z.string() }),
            metadata: z.object({ ip: pii(z.string()) }),
          },
          counter: { prefix: "count", key: z.object({ id: z.string() }), value: z.number() },
        },
      },
    },
  });
}

describe("privacyInventory", () => {
  test("walks every composed capability's D1 tables and KV stores, naming each marked field", () => {
    const inventory = privacyInventory([app()]);
    expect(inventory.sources).toEqual([...PRIVACY_SOURCES]);
    expect(inventory.schemas).toEqual([
      {
        capability: "app",
        storage: "d1",
        container: "app",
        name: "patients",
        fields: [
          { path: "email", class: "pii", encryptedAtRest: false },
          { path: "diagnosis", class: "phi", encryptedAtRest: false },
        ],
        encrypted: [],
      },
      {
        capability: "app",
        storage: "kv",
        container: "sessions",
        name: "session",
        fields: [
          { path: "key.email", class: "pii", encryptedAtRest: false },
          { path: "value.token", class: "secret", encryptedAtRest: false },
          { path: "metadata.ip", class: "pii", encryptedAtRest: false },
        ],
        encrypted: [],
      },
    ]);
    expect(inventory.schemasWalked).toBe(4);
  });

  test("counts fields per class, and lists the classes it observed in the built-in order", () => {
    const inventory = privacyInventory([app()]);
    expect(inventory.counts).toEqual({ secret: 1, pii: 3, phi: 1 });
    expect(inventory.observed).toEqual(["secret", "pii", "phi"]);
  });

  test("reflects the code: an unmarked field is simply not there", () => {
    const unmarked = z
      .object({ id: z.string().describe("id"), email: z.string().describe("email"), diagnosis: z.string() })
      .describe("patients");
    const inventory = privacyInventory([app({ patients: unmarked })]);
    expect(inventory.counts.phi).toBeUndefined();
    expect(inventory.schemas.map((schema) => schema.name)).toEqual(["session"]);
  });

  test("is empty, and says what it covered, for a Worker with no storage", () => {
    const inventory = privacyInventory([defineCapability({ name: "bare", requiredBindings: [] })]);
    expect(inventory).toEqual({
      sources: [...PRIVACY_SOURCES],
      schemasWalked: 0,
      schemas: [],
      counts: {},
      observed: [],
      encryptedFields: 0,
      unrotatable: 0,
    });
  });
});

describe("privacyInventory paths", () => {
  test("joins a KV part to an element path the way classifyPrivacy and the scan write it", () => {
    const capability = defineCapability({
      name: "list",
      requiredBindings: [],
      kvNamespaces: {
        lists: {
          binding: "LISTS",
          stores: {
            members: {
              prefix: "m",
              key: z.object({ id: z.string() }),
              value: z.array(z.object({ email: pii(z.string()) })),
              metadata: z.tuple([z.string(), pii(z.string())]),
            },
          },
        },
      },
    });
    expect(privacyInventory([capability]).schemas[0]?.fields).toEqual([
      { path: "value[].email", class: "pii", encryptedAtRest: false },
      { path: "metadata[1]", class: "pii", encryptedAtRest: false },
    ]);
  });
});

describe("privacyInventory references", () => {
  test("every sameAs in a KV inventory names a path the same report lists", () => {
    let node: z.ZodType = z.object({ e: pii(z.string()) });
    for (let level = 0; level < 20; level += 1) node = z.object({ a: node.optional(), b: node.optional() });
    const capability = defineCapability({
      name: "shared",
      requiredBindings: [],
      kvNamespaces: {
        cache: {
          binding: "CACHE",
          stores: { profile: { prefix: "p", key: z.object({ id: z.string() }), value: z.object({ t: node }) } },
        },
      },
    });
    const fields = privacyInventory([capability]).schemas[0]?.fields ?? [];
    const listed = fields.filter((field) => field.sameAs === undefined).map((field) => field.path);
    const references = fields.filter((field) => field.sameAs !== undefined);
    expect(references.length).toBeGreaterThan(0);
    for (const { sameAs } of references) {
      expect(sameAs?.startsWith("value.")).toBe(true);
      expect(listed.some((path) => path === sameAs || path.startsWith(`${sameAs}.`))).toBe(true);
    }
  });
});

describe("privacyInventory, past the depth limit", () => {
  test("lists every class, assumed, for a KV value built anew past the recursion limit, and none for one defined once", () => {
    // biome-ignore lint/suspicious/noExplicitAny: a factory's type is circular, and TypeScript infers none.
    const factory = (): any => z.object({ a: z.string(), next: z.lazy(factory).optional() });
    const capability = defineCapability({
      name: "deep",
      requiredBindings: [],
      kvNamespaces: {
        trees: {
          binding: "TREES",
          stores: {
            tree: { prefix: "t", key: z.object({ id: z.string() }), value: factory().transform((v: unknown) => v) },
          },
        },
      },
    });
    const inventory = privacyInventory([capability]);
    expect(inventory.schemasWalked).toBe(1);
    // Nothing past the limit was read, so any class may be marked there: each is listed, and observed.
    const every = unreadClasses();
    expect(inventory.schemas).toEqual([
      {
        capability: "deep",
        storage: "kv",
        container: "trees",
        name: "tree",
        // An assumed class is a field the core cannot say is encrypted, so it says nothing: never `false`.
        fields: every.map((name) => ({ path: "value", class: name, truncated: true })),
        encrypted: [],
      },
    ]);
    expect([...inventory.observed].sort()).toEqual([...every].sort());
    // Defined once, the recursion comes round to a schema already read: nothing is assumed.
    const Once: z.ZodType = z.object({ a: z.string(), next: z.lazy(() => Once).optional() });
    const once = defineCapability({
      name: "once",
      requiredBindings: [],
      kvNamespaces: {
        trees: {
          binding: "TREES",
          stores: {
            tree: { prefix: "t", key: z.object({ id: z.string() }), value: Once.transform((v: unknown) => v) },
          },
        },
      },
    });
    expect(privacyInventory([once]).schemas).toEqual([]);
  });
});

describe("lazyPrivacyInventory", () => {
  test("walks nothing until it is read, then walks once for the isolate", () => {
    let walks = 0;
    const inventory = lazyPrivacyInventory(() => {
      walks += 1;
      return [app()];
    });
    expect(walks).toBe(0);
    const first = inventory();
    const second = inventory();
    expect(walks).toBe(1);
    expect(second).toBe(first);
  });
});

describe("privacyInventory, encrypted at rest (#390)", () => {
  const Charts = encryptedTable(
    z.object({
      id: z.string().describe("id"),
      diagnosis: encrypted(phi(z.string().describe("diagnosis"))),
      email: pii(z.string().describe("email")),
      memo: encrypted(z.string().describe("memo")).nullable(),
      lookup: encrypted(pii(z.string().describe("lookup")), { index: "email" }),
      lookupIndex: blindIndex("lookup"),
    }),
    { name: "record", key: "id" },
  );

  test("each field record carries encrypted-at-rest, and an unclassed encrypted field is listed too", () => {
    const inventory = privacyInventory([app({ records: Charts })]);
    const records = inventory.schemas.find((schema) => schema.name === "records");
    expect(records?.fields).toEqual([
      { path: "diagnosis", class: "phi", encryptedAtRest: true },
      { path: "email", class: "pii", encryptedAtRest: false },
      { path: "lookup", class: "pii", encryptedAtRest: true },
    ]);
    expect(records?.encrypted).toEqual([{ path: "diagnosis" }, { path: "memo" }, { path: "lookup" }]);
    expect(inventory.encryptedFields).toBe(3);
    expect(inventory.unrotatable).toBe(0);
  });

  test("which PHI fields are encrypted at rest is a derivation over the records", () => {
    const inventory = privacyInventory([app({ records: Charts })]);
    const phiAtRest = inventory.schemas.flatMap((schema) =>
      schema.fields.filter((field) => field.class === "phi" && field.encryptedAtRest).map((field) => field.path),
    );
    expect(phiAtRest).toEqual(["diagnosis"]);
  });

  test("an encrypted field outside D1 is reported as encrypted but unrotatable, from its storage kind", () => {
    const capability = defineCapability({
      name: "cache",
      requiredBindings: [],
      kvNamespaces: {
        cache: {
          binding: "CACHE",
          stores: {
            tokens: {
              prefix: "t",
              key: z.object({ id: z.string() }),
              value: z.object({ token: encrypted(secret(z.string())) }),
            },
          },
        },
      },
    });
    const inventory = privacyInventory([capability]);
    expect(inventory.schemas[0]?.fields).toEqual([
      { path: "value.token", class: "secret", encryptedAtRest: true, unrotatable: true },
    ]);
    expect(inventory.schemas[0]?.encrypted).toEqual([{ path: "value.token", unrotatable: true }]);
    expect(inventory.unrotatable).toBe(1);
  });
});

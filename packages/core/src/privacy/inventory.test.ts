// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { describe, expect, test } from "vitest";
import { z } from "zod";
import { type Capability, defineCapability } from "../capability/capability";
import { phi, pii, secret } from "./classes";
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
          { path: "email", class: "pii" },
          { path: "diagnosis", class: "phi" },
        ],
      },
      {
        capability: "app",
        storage: "kv",
        container: "sessions",
        name: "session",
        fields: [
          { path: "key.email", class: "pii" },
          { path: "value.token", class: "secret" },
          { path: "metadata.ip", class: "pii" },
        ],
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
      { path: "value[].email", class: "pii" },
      { path: "metadata[1]", class: "pii" },
    ]);
  });
});

describe("privacyInventory, past the depth limit", () => {
  test("lists a KV value it could not read to the end as secret, and keeps the truncated flag", () => {
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
    expect(privacyInventory([capability]).schemas[0]?.fields).toEqual([
      { path: "value", class: "secret", truncated: true },
    ]);
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

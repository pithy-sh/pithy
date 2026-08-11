// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import type { Capability } from "@pithy-sh/core/src/capability/capability";
import { describe, expect, test } from "vitest";
import { checkExtensions, describeExtension } from "./extensions";

function capability(name: string, extensions?: Capability["extensions"]): Capability {
  return { name, requiredBindings: [], ...(extensions ? { extensions } : {}) };
}

describe("checkExtensions()", () => {
  test("a project whose capabilities declare none reports none", () => {
    expect(checkExtensions([{ name: "board", capabilities: [capability("auth"), capability("email")] }])).toEqual({
      extensions: [],
    });
  });

  test("an extension is reported with the Worker and the capability it was plugged into", () => {
    const check = checkExtensions([
      {
        name: "board",
        capabilities: [
          capability("auth", [
            { kind: "better-auth-plugin", id: "organization", tables: ["organization", "member"] },
            { kind: "better-auth-plugin", id: "admin" },
          ]),
        ],
      },
    ]);

    expect(check.extensions).toEqual([
      {
        worker: "board",
        capability: "auth",
        kind: "better-auth-plugin",
        id: "organization",
        tables: ["organization", "member"],
      },
      { worker: "board", capability: "auth", kind: "better-auth-plugin", id: "admin", tables: [] },
    ]);
  });

  test("every Worker is asked — a plugin composed in one is not reported against another", () => {
    const check = checkExtensions([
      { name: "board", capabilities: [capability("auth", [{ kind: "better-auth-plugin", id: "passkey" }])] },
      { name: "replay", capabilities: [capability("auth")] },
    ]);
    expect(check.extensions.map((entry) => [entry.worker, entry.id])).toEqual([["board", "passkey"]]);
  });
});

describe("describeExtension()", () => {
  test("names the capability, the extension, and what it put in the database", () => {
    expect(
      describeExtension({
        worker: "board",
        capability: "auth",
        kind: "better-auth-plugin",
        id: "organization",
        tables: ["organization", "member"],
      }),
    ).toBe("auth: organization (better-auth-plugin), tables organization, member.");
  });

  test("a plugin that brought no tables says so rather than trailing off", () => {
    expect(
      describeExtension({ worker: "board", capability: "auth", kind: "better-auth-plugin", id: "admin", tables: [] }),
    ).toBe("auth: admin (better-auth-plugin), no tables.");
  });
});

// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { describe, expect, test } from "vitest";
import { currentSchemaVersion, stampSchemaVersion, withSchemaVersion } from "./schemaVersion";

/**
 * **Every `--json` payload names the version of its shape (#697), and the call site never says so.**
 *
 * A command runs inside its own version (`withContract` installs it); the formatter stamps it. These pin the
 * two halves: the span carries across `await`, and the stamp lands straight after `command` so a line still
 * reads from its name, with nothing stamped outside a span.
 */

describe("withSchemaVersion", () => {
  test("installs the version for the work, across awaits, and nowhere else", async () => {
    expect(currentSchemaVersion()).toBeUndefined();
    const seen = await withSchemaVersion(3, async () => {
      await new Promise((resolve) => setTimeout(resolve, 1));
      return currentSchemaVersion();
    });
    expect(seen).toBe(3);
    expect(currentSchemaVersion()).toBeUndefined();
  });

  test("an inner command's version wins inside it, and the outer one comes back after", async () => {
    await withSchemaVersion(1, async () => {
      expect(await withSchemaVersion(2, async () => currentSchemaVersion())).toBe(2);
      expect(currentSchemaVersion()).toBe(1);
    });
  });
});

describe("stampSchemaVersion", () => {
  test("outside a command, a payload is left exactly as it was", () => {
    const payload = { command: "env", envs: [] };
    expect(stampSchemaVersion(payload)).toBe(payload);
  });

  test("inside one, the version lands straight after command", () => {
    const stamped = withSchemaVersion(1, () => stampSchemaVersion({ command: "env", envs: [], ok: true }));
    expect(Object.entries(stamped)).toEqual([
      ["command", "env"],
      ["schemaVersion", 1],
      ["envs", []],
      ["ok", true],
    ]);
  });

  test("a payload with no command opens with the version", () => {
    const stamped = withSchemaVersion(2, () => stampSchemaVersion({ ok: true, checks: 3 }));
    expect(Object.keys(stamped)).toEqual(["schemaVersion", "ok", "checks"]);
    expect(stamped.schemaVersion).toBe(2);
  });

  test("the command's version replaces any the payload carried, so the line has one", () => {
    const stamped = withSchemaVersion(4, () => stampSchemaVersion({ command: "x", schemaVersion: 9, a: 1 }));
    expect(Object.entries(stamped)).toEqual([
      ["command", "x"],
      ["schemaVersion", 4],
      ["a", 1],
    ]);
  });
});

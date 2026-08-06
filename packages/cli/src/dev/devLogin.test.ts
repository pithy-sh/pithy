// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEV_LOGIN_PATH, type DevLogin } from "@pithy-sh/core/src/seed/devLogin";
import { describe, expect, test } from "vitest";
import { devLoginLines, readDevLogin } from "./devLogin";

const NOW = new Date("2026-08-06T00:00:00.000Z");

function login(overrides: Partial<DevLogin> = {}): DevLogin {
  return {
    email: "ada@example.com",
    userId: "example-ada",
    cookieName: "better-auth.session_token",
    cookieValue: "dev-session-example-ada-abcd.c2ln",
    expiresAt: new Date("2027-08-06T00:00:00.000Z"),
    ...overrides,
  };
}

describe("devLoginLines", () => {
  test("names the user and hands over a line that signs the browser in", () => {
    const lines = devLoginLines(login(), NOW);
    expect(lines[0]).toBe("Dev login: ada@example.com. Paste into the browser console, then reload.");
    expect(lines[1]).toContain('document.cookie = "better-auth.session_token=dev-session-example-ada-abcd.c2ln;');
    expect(lines[1]).toContain("path=/");
    expect(lines[1]).toContain(`max-age=${365 * 24 * 60 * 60}`);
  });

  test("says nothing when the seed never wrote one", () => {
    expect(devLoginLines(undefined, NOW)).toEqual([]);
  });

  test("says nothing about an expired session rather than offering a dead cookie", () => {
    expect(devLoginLines(login({ expiresAt: new Date("2026-08-05T00:00:00.000Z") }), NOW)).toEqual([]);
  });
});

describe("readDevLogin", () => {
  test("reads what the seed wrote", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pithy-dev-login-"));
    await mkdir(join(dir, "logs"), { recursive: true });
    await writeFile(
      join(dir, DEV_LOGIN_PATH),
      JSON.stringify({
        email: "ada@example.com",
        userId: "example-ada",
        cookieName: "better-auth.session_token",
        cookieValue: "value",
        expiresAt: "2027-08-06T00:00:00.000Z",
      }),
    );
    expect((await readDevLogin(dir))?.email).toBe("ada@example.com");
  });

  test("is undefined when the file is absent or does not validate", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pithy-dev-login-"));
    expect(await readDevLogin(dir)).toBeUndefined();
    await mkdir(join(dir, "logs"), { recursive: true });
    await writeFile(join(dir, DEV_LOGIN_PATH), '{ "email": "ada@example.com" }');
    expect(await readDevLogin(dir)).toBeUndefined();
  });
});

// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEV_LOGIN_PATH, type DevLogin } from "@pithy-sh/core/src/seed/devLogin";
import { describe, expect, test } from "vitest";
import { type DevLoginTarget, devLoginKeyAction, devLoginLines, devLoginUrl, readDevLogin } from "./devLogin";

const NOW = new Date("2026-08-06T00:00:00.000Z");
const API: DevLoginTarget = { name: "api", origin: "http://localhost:8787" };
const ADMIN: DevLoginTarget = { name: "admin", origin: "http://localhost:8788" };

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

/** Every line any of these functions can produce, for the one assertion that is not about wording. */
function everyLine(): string[] {
  return [
    ...devLoginLines(login(), NOW, { interactive: true, targets: [API], ci: false }),
    ...devLoginLines(login(), NOW, { interactive: false, targets: [API], ci: false }),
    ...devLoginLines(login(), NOW, { interactive: true, targets: [API, ADMIN], ci: false }),
    ...devLoginLines(login(), NOW, { interactive: false, targets: [API, ADMIN], ci: false }),
    ...devLoginLines(login(), NOW, { interactive: true, targets: [], ci: false }),
    ...devLoginKeyAction(login(), NOW, [API]).lines,
    ...devLoginKeyAction(login(), NOW, [API, ADMIN]).lines,
    ...devLoginKeyAction(login(), NOW, []).lines,
    ...devLoginLines(login(), NOW, { interactive: true, targets: [API], ci: true }),
    ...devLoginKeyAction(login(), NOW, [API], true).lines,
  ];
}

describe("the cookie", () => {
  test("reaches no line this module can print", () => {
    // The reason the feature exists. `pithy dev`'s output is tee'd, read, pasted and screenshotted, so a
    // session token printed once is a session token at rest. It now travels over HTTP or not at all.
    for (const line of everyLine()) {
      expect(line).not.toContain(login().cookieValue);
      expect(line).not.toContain("document.cookie");
      expect(line).not.toContain(login().cookieName);
    }
  });
});

describe("devLoginUrl", () => {
  test("is the origin plus the route both ends share", () => {
    expect(devLoginUrl(API.origin)).toBe("http://localhost:8787/__pithy/dev-login");
  });
});

describe("devLoginLines", () => {
  test("names the user and offers the keypress on a TTY", () => {
    expect(devLoginLines(login(), NOW, { interactive: true, targets: [API], ci: false })).toEqual([
      "Dev login: ada@example.com — press l to open a signed-in browser.",
    ]);
  });

  test("prints the URL, never the cookie, where there is no keypress to offer", () => {
    expect(devLoginLines(login(), NOW, { interactive: false, targets: [API], ci: false })).toEqual([
      "Dev login: ada@example.com — open http://localhost:8787/__pithy/dev-login to sign in.",
    ]);
  });

  test("does not guess between two workers that both compose auth", () => {
    expect(devLoginLines(login(), NOW, { interactive: true, targets: [API, ADMIN], ci: false })).toEqual([
      "Dev login: ada@example.com — press l to choose a worker and open a signed-in browser.",
    ]);
    expect(devLoginLines(login(), NOW, { interactive: false, targets: [API, ADMIN], ci: false })).toEqual([
      "Dev login: ada@example.com — open one of these to sign in.",
      "  api: http://localhost:8787/__pithy/dev-login",
      "  admin: http://localhost:8788/__pithy/dev-login",
    ]);
  });

  test("says so rather than offering a keypress with nothing to open", () => {
    expect(devLoginLines(login(), NOW, { interactive: true, targets: [], ci: false })).toEqual([
      "Dev login: ada@example.com — no running worker composes auth, so there is nothing to open.",
    ]);
  });

  test("says nothing when the seed never wrote one", () => {
    expect(devLoginLines(undefined, NOW, { interactive: true, targets: [API], ci: false })).toEqual([]);
  });

  test("says nothing about an expired session rather than offering a dead way in", () => {
    const expired = login({ expiresAt: new Date("2026-08-05T00:00:00.000Z") });
    expect(devLoginLines(expired, NOW, { interactive: true, targets: [API], ci: false })).toEqual([]);
  });

  test("offers no keypress under CI, because the capability registers no route there", () => {
    // The keypress follows the route. `l` here would open a 404, and CI is the one refusal `pithy dev`
    // can see coming — the worker below composes auth and still mounts nothing.
    expect(devLoginLines(login(), NOW, { interactive: true, targets: [API], ci: true })).toEqual([
      "Dev login: ada@example.com — the dev-login route is not registered under CI.",
    ]);
  });
});

describe("devLoginKeyAction", () => {
  test("opens the one worker that carries the route", () => {
    const action = devLoginKeyAction(login(), NOW, [API]);
    expect(action.url).toBe("http://localhost:8787/__pithy/dev-login");
    expect(action.lines).toEqual(["Opening http://localhost:8787/__pithy/dev-login as ada@example.com."]);
  });

  test("prints the choices rather than guessing between workers", () => {
    const action = devLoginKeyAction(login(), NOW, [API, ADMIN]);
    expect(action.url).toBeUndefined();
    expect(action.lines).toEqual([
      "More than one worker composes auth. Open the one you want:",
      "  api: http://localhost:8787/__pithy/dev-login",
      "  admin: http://localhost:8788/__pithy/dev-login",
    ]);
  });

  test("names pithy seed rather than opening a URL that 404s", () => {
    const action = devLoginKeyAction(undefined, NOW, [API]);
    expect(action.url).toBeUndefined();
    expect(action.lines).toEqual(["No dev login is seeded. Run pithy seed, then press l again."]);
  });

  test("treats an expired login as no login, and says how to mint a fresh one", () => {
    const action = devLoginKeyAction(login({ expiresAt: new Date("2026-08-05T00:00:00.000Z") }), NOW, [API]);
    expect(action.url).toBeUndefined();
    expect(action.lines).toEqual(["The seeded dev login has expired. Run pithy seed to mint a fresh one."]);
  });

  test("opens nothing when no running worker composes auth", () => {
    const action = devLoginKeyAction(login(), NOW, []);
    expect(action.url).toBeUndefined();
    expect(action.lines).toEqual(["No running worker composes auth, so there is nothing to open."]);
  });

  test("opens nothing under CI, and says which refusal it was", () => {
    const action = devLoginKeyAction(login(), NOW, [API], true);
    expect(action.url).toBeUndefined();
    expect(action.lines).toEqual(["Not opening — the dev-login route is not registered under CI."]);
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

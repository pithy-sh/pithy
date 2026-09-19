// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEV_LOGIN_PATH, type DevLogin } from "@pithy-sh/core/src/seed/devLogin";
import { describe, expect, test } from "vitest";
import {
  claimIsPrinted,
  type DevLoginTarget,
  devLoginKeyAction,
  devLoginLines,
  devLoginUrl,
  readDevLogin,
  seededLoginLines,
} from "./devLogin";

const NOW = new Date("2026-08-06T00:00:00.000Z");
const API: DevLoginTarget = { name: "api", origin: "http://localhost:8787" };
const ADMIN: DevLoginTarget = { name: "admin", origin: "http://localhost:8788" };

const CLAIM = "eyJ1IjoiZXhhbXBsZS1hZGEiLCJlIjoxODAwMH0%3D.c2lnbmF0dXJl";

function login(overrides: Partial<DevLogin> = {}): DevLogin {
  return {
    email: "ada@example.com",
    userId: "example-ada",
    claim: CLAIM,
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

describe("the credential", () => {
  test("no session cookie reaches any line this module can print", () => {
    // The reason the feature exists. `pithy dev`'s output is tee'd, read, pasted and screenshotted, so a
    // session token printed once is a session token at rest. It travels over HTTP or not at all — and
    // since `#572` the terminal never sees one at all, because the seed no longer mints one.
    for (const line of everyLine()) {
      expect(line).not.toContain("document.cookie");
      expect(line).not.toContain("better-auth.session_token");
    }
  });

  test("**the claim is printed only where the CLI cannot open the browser itself**", () => {
    // `#572` puts a claim in the URL, and a claim is a credential. It is kept out of every line the CLI
    // can avoid printing; where a person must click a link — no keypress, or more than one worker — a
    // link without it would 404, so it is printed and this is the boundary that says where.
    const held = login().claim;
    for (const [interactive, targets, where] of [
      [true, [API], "interactive, one worker"],
      [false, [API], "non-interactive, one worker"],
      [true, [API, ADMIN], "interactive, two workers"],
      [false, [API, ADMIN], "non-interactive, two workers"],
      [true, [], "nothing composes auth"],
    ] as const) {
      const banner = devLoginLines(login(), NOW, { interactive, targets, ci: false });
      expect({ where, printed: banner.some((line) => line.includes(held)) }).toEqual({
        where,
        printed: claimIsPrinted("banner", interactive, targets.length),
      });

      // The keypress is the other surface, and it prints under a different condition: with one worker it
      // opens the browser itself, so nothing is printed however interactive the run is.
      const press = devLoginKeyAction(login(), NOW, targets);
      expect({ where, printed: press.lines.some((line) => line.includes(held)) }).toEqual({
        where,
        printed: claimIsPrinted("keypress", interactive, targets.length),
      });
    }
  });

  test("pressing `l` with one worker opens the claim and prints none of it", () => {
    // The ordinary case, and the one worth protecting: the URL goes to the browser, the terminal gets a
    // name. `openUrl` is handed the credential; nothing a human reads is.
    const action = devLoginKeyAction(login(), NOW, [API]);
    expect(action.url).toContain(login().claim);
    for (const line of action.lines) expect(line).not.toContain(login().claim);
  });
});

describe("devLoginUrl", () => {
  test("is the origin, the route both ends share, and the claim", () => {
    expect(devLoginUrl(API.origin, "abc")).toBe("http://localhost:8787/__pithy/dev-login?t=abc");
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
      `Dev login: ada@example.com — open http://localhost:8787/__pithy/dev-login?t=${CLAIM} to sign in.`,
    ]);
  });

  test("does not guess between two workers that both compose auth", () => {
    expect(devLoginLines(login(), NOW, { interactive: true, targets: [API, ADMIN], ci: false })).toEqual([
      "Dev login: ada@example.com — press l to choose a worker and open a signed-in browser.",
    ]);
    expect(devLoginLines(login(), NOW, { interactive: false, targets: [API, ADMIN], ci: false })).toEqual([
      "Dev login: ada@example.com — open one of these to sign in.",
      `  api: http://localhost:8787/__pithy/dev-login?t=${CLAIM}`,
      `  admin: http://localhost:8788/__pithy/dev-login?t=${CLAIM}`,
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
    expect(action.url).toBe(`http://localhost:8787/__pithy/dev-login?t=${CLAIM}`);
    // The URL is opened, not printed — it carries the claim, and `#572` keeps that out of the terminal
    // on every run where the CLI can hand it to a browser itself.
    expect(action.lines).toEqual(["Opening the dev login for ada@example.com."]);
  });

  test("prints the choices rather than guessing between workers", () => {
    const action = devLoginKeyAction(login(), NOW, [API, ADMIN]);
    expect(action.url).toBeUndefined();
    expect(action.lines).toEqual([
      "More than one worker composes auth. Open the one you want:",
      `  api: http://localhost:8787/__pithy/dev-login?t=${CLAIM}`,
      `  admin: http://localhost:8788/__pithy/dev-login?t=${CLAIM}`,
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
        claim: "a-claim",
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

/**
 * **A feature's dev login is a URL someone can open (#643).** `pithy dev` composes its link from the pinned
 * port. A feature deployment has none, so the login carries the origin it was minted for, and `pithy seed
 * --env feature` prints the link over it — reading `dev-login.feature.json`, which nothing used to read.
 */
describe("a seeded login off dev", () => {
  const ORIGIN = "https://replay-f643-feature-address-board.acme.workers.dev";

  test("reads the environment's own login file, never dev's", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pithy-devlogin-env-"));
    await mkdir(join(dir, "logs"), { recursive: true });
    const stored = { email: "ada@example.com", userId: "example-ada", claim: CLAIM, expiresAt: NOW.toISOString() };
    await writeFile(join(dir, "logs", "dev-login.json"), JSON.stringify(stored));
    await writeFile(join(dir, "logs", "dev-login.feature.json"), JSON.stringify({ ...stored, origin: ORIGIN }));

    expect((await readDevLogin(dir, "feature"))?.origin).toBe(ORIGIN);
    expect((await readDevLogin(dir))?.origin).toBeUndefined();
  });

  test("is one line with the link over the deployment's own origin", () => {
    expect(seededLoginLines(login({ origin: ORIGIN }), NOW)).toEqual([
      `Dev login: ada@example.com — open ${ORIGIN}/__pithy/dev-login?t=${CLAIM} to sign in.`,
    ]);
  });

  test("with no origin, says so rather than inventing one", () => {
    expect(seededLoginLines(login(), NOW)).toEqual([
      "Dev login: ada@example.com — this environment has no address to open it on. Pass --host.",
    ]);
  });

  test("an expired or absent login says nothing", () => {
    expect(seededLoginLines(undefined, NOW)).toEqual([]);
    expect(seededLoginLines(login({ expiresAt: new Date(NOW.getTime() - 1) }), NOW)).toEqual([]);
  });
});

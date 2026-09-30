// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEV_LOGIN_PATH, type DevLogin, DevLogins } from "@pithy-sh/core/src/seed/devLogin";
import { describe, expect, test } from "vitest";
import {
  claimIsPrinted,
  type DevLoginTarget,
  devLoginChoice,
  devLoginChoiceLines,
  devLoginIdentities,
  devLoginKeyAction,
  devLoginLines,
  devLoginUrl,
  pickDevLoginByKey,
  readDevLogins,
  selectDevLogin,
  usableDevLogins,
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

/** The one-identity record, holding exactly the login the assertions below are written against. */
function one(overrides: Partial<DevLogin> = {}): DevLogins {
  return { "example-ada": login(overrides) };
}

/**
 * Every line any of these functions can produce for one record, for the assertions that are not about wording.
 *
 * Taken over a *record* — `#667`. The claim boundary is a property of the module, and the module now
 * answers for several identities at once, so asserting it over a single entry would leave every line the
 * multi-identity shapes produce unasserted.
 */
function everyLine(record: DevLogins): string[] {
  const live = usableDevLogins(record, NOW);
  return [
    ...devLoginLines(record, NOW, { interactive: true, targets: [API], ci: false }),
    ...devLoginLines(record, NOW, { interactive: false, targets: [API], ci: false }),
    ...devLoginLines(record, NOW, { interactive: true, targets: [API, ADMIN], ci: false }),
    ...devLoginLines(record, NOW, { interactive: false, targets: [API, ADMIN], ci: false }),
    ...devLoginLines(record, NOW, { interactive: true, targets: [], ci: false }),
    ...devLoginLines(record, NOW, { interactive: true, targets: [API], ci: true }),
    ...devLoginChoiceLines(live),
    ...selectDevLogin(record, NOW, "nobody@example.com").lines,
    ...live.flatMap((entry) => [
      ...devLoginKeyAction(entry, NOW, [API]).lines,
      ...devLoginKeyAction(entry, NOW, [API, ADMIN]).lines,
      ...devLoginKeyAction(entry, NOW, []).lines,
      ...devLoginKeyAction(entry, NOW, [API], true).lines,
    ]),
  ];
}

describe("the credential", () => {
  test("no session cookie reaches any line this module can print", () => {
    // The reason the feature exists. `pithy dev`'s output is tee'd, read, pasted and screenshotted, so a
    // session token printed once is a session token at rest. It travels over HTTP or not at all — and
    // since `#572` the terminal never sees one at all, because the seed no longer mints one.
    for (const record of [one(), many(3)]) {
      for (const line of everyLine(record)) {
        expect(line).not.toContain("document.cookie");
        expect(line).not.toContain("better-auth.session_token");
      }
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
      const banner = devLoginLines(one(), NOW, { interactive, targets, ci: false });
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

  test("**the boundary is the same over a record of several identities** — it is a workers rule, not a users one", () => {
    // `#667`. `claimIsPrinted` is unchanged and takes no count of users, and this is what says so: the
    // same five shapes, asserted against the same predicate, over three identities instead of one.
    // Folding users into it would have made this a workers × users matrix with nothing to gain.
    const record = many(3);
    const held = usableDevLogins(record, NOW).map((entry) => entry.claim);
    for (const [interactive, targets, where] of [
      [true, [API], "interactive, one worker"],
      [false, [API], "non-interactive, one worker"],
      [true, [API, ADMIN], "interactive, two workers"],
      [false, [API, ADMIN], "non-interactive, two workers"],
      [true, [], "nothing composes auth"],
    ] as const) {
      const banner = devLoginLines(record, NOW, { interactive, targets, ci: false });
      expect({ where, printed: banner.some((line) => held.some((claim) => line.includes(claim))) }).toEqual({
        where,
        printed: claimIsPrinted("banner", interactive, targets.length),
      });

      for (const entry of usableDevLogins(record, NOW)) {
        const press = devLoginKeyAction(entry, NOW, targets);
        expect({ where, printed: press.lines.some((line) => line.includes(entry.claim)) }).toEqual({
          where,
          printed: claimIsPrinted("keypress", interactive, targets.length),
        });
      }
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
    expect(devLoginLines(one(), NOW, { interactive: true, targets: [API], ci: false })).toEqual([
      "Dev login: ada@example.com — press l to open a signed-in browser.",
    ]);
  });

  test("prints the URL, never the cookie, where there is no keypress to offer", () => {
    expect(devLoginLines(one(), NOW, { interactive: false, targets: [API], ci: false })).toEqual([
      `Dev login: ada@example.com — open http://localhost:8787/__pithy/dev-login?t=${CLAIM} to sign in.`,
    ]);
  });

  test("does not guess between two workers that both compose auth", () => {
    expect(devLoginLines(one(), NOW, { interactive: true, targets: [API, ADMIN], ci: false })).toEqual([
      "Dev login: ada@example.com — press l to choose a worker and open a signed-in browser.",
    ]);
    expect(devLoginLines(one(), NOW, { interactive: false, targets: [API, ADMIN], ci: false })).toEqual([
      "Dev login: ada@example.com — open one of these to sign in.",
      `  api: http://localhost:8787/__pithy/dev-login?t=${CLAIM}`,
      `  admin: http://localhost:8788/__pithy/dev-login?t=${CLAIM}`,
    ]);
  });

  test("says so rather than offering a keypress with nothing to open", () => {
    expect(devLoginLines(one(), NOW, { interactive: true, targets: [], ci: false })).toEqual([
      "Dev login: ada@example.com — no running worker composes auth, so there is nothing to open.",
    ]);
  });

  test("says nothing when the seed never wrote one", () => {
    expect(devLoginLines(undefined, NOW, { interactive: true, targets: [API], ci: false })).toEqual([]);
  });

  test("says nothing about an expired session rather than offering a dead way in", () => {
    const expired = one({ expiresAt: new Date("2026-08-05T00:00:00.000Z") });
    expect(devLoginLines(expired, NOW, { interactive: true, targets: [API], ci: false })).toEqual([]);
  });

  test("**names the count, not a user, once there is a choice to make**", () => {
    // `#667`. With several identities the banner cannot name *the* user, because there is no such thing
    // until somebody chooses. It says how many there are and that `l` is where the choosing happens.
    expect(devLoginLines(many(3), NOW, { interactive: true, targets: [API], ci: false })).toEqual([
      "Dev login: 3 identities — press l to choose who to be and open a signed-in browser.",
    ]);
  });

  test("says both choices are coming when more than one worker composes auth too", () => {
    expect(devLoginLines(many(3), NOW, { interactive: true, targets: [API, ADMIN], ci: false })).toEqual([
      "Dev login: 3 identities — press l to choose who to be, then a worker.",
    ]);
  });

  test("lists every identity against every worker where there is no keypress to offer", () => {
    // No keypress means a person clicks a link, and a link without the claim would 404 — the boundary
    // `claimIsPrinted` states, unchanged by how many identities exist.
    expect(devLoginLines(many(2), NOW, { interactive: false, targets: [API, ADMIN], ci: false })).toEqual([
      "Dev login: 2 identities — open one of these to sign in.",
      `  user1@example.com at api: http://localhost:8787/__pithy/dev-login?t=${CLAIM}-1`,
      `  user1@example.com at admin: http://localhost:8788/__pithy/dev-login?t=${CLAIM}-1`,
      `  user2@example.com at api: http://localhost:8787/__pithy/dev-login?t=${CLAIM}-2`,
      `  user2@example.com at admin: http://localhost:8788/__pithy/dev-login?t=${CLAIM}-2`,
    ]);
  });

  test("counts only the identities that are usable, so an expired one is not offered", () => {
    expect(
      devLoginLines(many(3, { "example-2": { expiresAt: EXPIRED } }), NOW, {
        interactive: true,
        targets: [API],
        ci: false,
      }),
    ).toEqual(["Dev login: 2 identities — press l to choose who to be and open a signed-in browser."]);
  });

  test("falls back to naming the one user when expiry leaves exactly one", () => {
    // Not a special case — a project with one usable identity *is* the single-identity case, however many
    // the seed wrote, and it gets that case's sentence.
    expect(
      devLoginLines(many(3, { "example-1": { expiresAt: EXPIRED }, "example-3": { expiresAt: EXPIRED } }), NOW, {
        interactive: true,
        targets: [API],
        ci: false,
      }),
    ).toEqual(["Dev login: user2@example.com — press l to open a signed-in browser."]);
  });

  test("says the count under CI, and with nothing composing auth", () => {
    expect(devLoginLines(many(3), NOW, { interactive: true, targets: [API], ci: true })).toEqual([
      "Dev login: 3 identities — the dev-login route is not registered under CI.",
    ]);
    expect(devLoginLines(many(3), NOW, { interactive: true, targets: [], ci: false })).toEqual([
      "Dev login: 3 identities — no running worker composes auth, so there is nothing to open.",
    ]);
  });

  test("offers no keypress under CI, because the capability registers no route there", () => {
    // The keypress follows the route. `l` here would open a 404, and CI is the one refusal `pithy dev`
    // can see coming — the worker below composes auth and still mounts nothing.
    expect(devLoginLines(one(), NOW, { interactive: true, targets: [API], ci: true })).toEqual([
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

const NOW2 = new Date("2026-08-06T00:00:00.000Z");

/** A record of `count` live identities, in seed order — the shape `logs/dev-login.json` now holds. */
function many(count: number, overrides: Partial<Record<string, Partial<DevLogin>>> = {}): DevLogins {
  const entries = Array.from({ length: count }, (_, index) => {
    const userId = `example-${index + 1}`;
    return [
      userId,
      {
        email: `user${index + 1}@example.com`,
        userId,
        claim: `${CLAIM}-${index + 1}`,
        expiresAt: new Date("2027-08-06T00:00:00.000Z"),
        ...overrides[userId],
      },
    ] as const;
  });
  return Object.fromEntries(entries);
}

const EXPIRED = new Date("2026-08-05T00:00:00.000Z");

describe("readDevLogins", () => {
  test("reads the record the seed wrote, keyed by user id", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pithy-dev-logins-"));
    await mkdir(join(dir, "logs"), { recursive: true });
    await writeFile(join(dir, DEV_LOGIN_PATH), JSON.stringify(DevLogins.encode(many(2))));
    const read = await readDevLogins(dir);
    expect(Object.keys(read ?? {})).toEqual(["example-1", "example-2"]);
    expect(read?.["example-2"]?.email).toBe("user2@example.com");
  });

  test("is undefined when the file is absent, unparseable, or the single-entry file this replaced", async () => {
    // The last one is the whole migration plan — `#667`. The artifact is gitignored and regenerated, so
    // an old file degrades to "no dev login until you reseed" rather than to a crash.
    const dir = await mkdtemp(join(tmpdir(), "pithy-dev-logins-"));
    expect(await readDevLogins(dir)).toBeUndefined();
    await mkdir(join(dir, "logs"), { recursive: true });
    await writeFile(join(dir, DEV_LOGIN_PATH), "{ not json");
    expect(await readDevLogins(dir)).toBeUndefined();
    await writeFile(
      join(dir, DEV_LOGIN_PATH),
      JSON.stringify({
        email: "ada@example.com",
        userId: "example-ada",
        claim: CLAIM,
        expiresAt: "2027-01-01T00:00:00.000Z",
      }),
    );
    expect(await readDevLogins(dir)).toBeUndefined();
  });
});

describe("usableDevLogins", () => {
  test("keeps the seed's order, because that is the order the picker offers", () => {
    expect(usableDevLogins(many(3), NOW2).map((login) => login.email)).toEqual([
      "user1@example.com",
      "user2@example.com",
      "user3@example.com",
    ]);
  });

  test("**drops one expired entry and keeps the rest** rather than disabling the feature", () => {
    // `usable()` applies per entry now. One stale claim used to be the only claim; it must not take three
    // working identities down with it.
    const some = many(3, { "example-2": { expiresAt: EXPIRED } });
    expect(usableDevLogins(some, NOW2).map((login) => login.email)).toEqual(["user1@example.com", "user3@example.com"]);
  });

  test("is empty for no record at all", () => {
    expect(usableDevLogins(undefined, NOW2)).toEqual([]);
  });
});

describe("devLoginIdentities", () => {
  test("reports the user id, the email and the expiry — and **no claim**", () => {
    // The `pithy dev --json` surface. An agent selects against it, so it names the identities; a claim is
    // a credential and has no business in a machine-readable line any more than in a human-readable one.
    expect(devLoginIdentities(many(2), NOW2)).toEqual([
      { userId: "example-1", email: "user1@example.com", expiresAt: "2027-08-06T00:00:00.000Z" },
      { userId: "example-2", email: "user2@example.com", expiresAt: "2027-08-06T00:00:00.000Z" },
    ]);
  });

  test("no field of any entry holds a claim, whatever the record", () => {
    // Asserted over the payload rather than over a spelling, so a field added later cannot smuggle one in.
    const payload = JSON.stringify(devLoginIdentities(many(3), NOW2));
    expect(payload).not.toContain(CLAIM);
  });

  test("lists what can be signed in as, so an expired identity is absent", () => {
    expect(devLoginIdentities(many(2, { "example-1": { expiresAt: EXPIRED } }), NOW2)).toEqual([
      { userId: "example-2", email: "user2@example.com", expiresAt: "2027-08-06T00:00:00.000Z" },
    ]);
  });

  test("is empty when the seed wrote nothing", () => {
    expect(devLoginIdentities(undefined, NOW2)).toEqual([]);
  });
});

describe("devLoginChoice", () => {
  test("one identity needs no choosing, so it hands the entry straight on", () => {
    // The ordinary case, and the one the acceptance criteria pin: a project seeding one user behaves
    // exactly as it did before there was an axis at all.
    expect(devLoginChoice(many(1), NOW2)).toEqual({ kind: "only", login: many(1)["example-1"] });
  });

  test("two to nine identities get the one-key numbered choice", () => {
    expect(devLoginChoice(many(9), NOW2)).toEqual({ kind: "keys", logins: usableDevLogins(many(9), NOW2) });
  });

  test("**ten or more get the filterable select**, because a numbered list runs out of digits", () => {
    expect(devLoginChoice(many(10), NOW2)).toEqual({ kind: "select", logins: usableDevLogins(many(10), NOW2) });
  });

  test("no record at all hands on `undefined`, which is what says `pithy seed`", () => {
    // The four shapes of `devLoginKeyAction` already distinguish "never seeded" from "expired", and this
    // keeps that distinction rather than collapsing it into one "nothing to open".
    expect(devLoginChoice(undefined, NOW2)).toEqual({ kind: "only", login: undefined });
  });

  test("every claim expired hands on an expired entry, so the reason survives", () => {
    const all = many(3, {
      "example-1": { expiresAt: EXPIRED },
      "example-2": { expiresAt: EXPIRED },
      "example-3": { expiresAt: EXPIRED },
    });
    expect(devLoginChoice(all, NOW2)).toEqual({ kind: "only", login: all["example-1"] });
  });

  test("counts only usable entries, so one live claim among expired ones needs no choosing", () => {
    const survivor = many(3, { "example-1": { expiresAt: EXPIRED }, "example-3": { expiresAt: EXPIRED } });
    expect(devLoginChoice(survivor, NOW2)).toEqual({ kind: "only", login: survivor["example-2"] });
  });
});

describe("selectDevLogin", () => {
  test("takes the user id, which is canonical", () => {
    expect(selectDevLogin(many(3), NOW2, "example-2").login?.email).toBe("user2@example.com");
  });

  test("takes the email, which is what a person actually knows", () => {
    expect(selectDevLogin(many(3), NOW2, "user3@example.com").login?.userId).toBe("example-3");
  });

  test("takes an email however it was typed, because refusing over a capital would be a puzzle", () => {
    expect(selectDevLogin(many(3), NOW2, "  User3@Example.com ").login?.userId).toBe("example-3");
  });

  test("**refuses an unknown value by name and selects nothing**", () => {
    const refused = selectDevLogin(many(2), NOW2, "nobody@example.com");
    expect(refused.login).toBeUndefined();
    expect(refused.lines).toEqual([
      "No seeded identity is nobody@example.com. Seeded: user1@example.com, user2@example.com.",
    ]);
  });

  test("refuses an expired identity by name rather than opening a dead way in", () => {
    const some = many(2, { "example-1": { expiresAt: EXPIRED } });
    const refused = selectDevLogin(some, NOW2, "example-1");
    expect(refused.login).toBeUndefined();
    expect(refused.lines).toEqual(["No seeded identity is example-1. Seeded: user2@example.com."]);
  });

  test("names pithy seed when every claim has expired, rather than listing nobody", () => {
    const all = many(2, { "example-1": { expiresAt: EXPIRED }, "example-2": { expiresAt: EXPIRED } });
    expect(selectDevLogin(all, NOW2, "example-1")).toEqual({
      lines: ["The seeded dev login has expired. Run pithy seed to mint a fresh one."],
    });
  });

  test("says so rather than listing nobody when the seed wrote nothing", () => {
    const refused = selectDevLogin(undefined, NOW2, "example-1");
    expect(refused.login).toBeUndefined();
    expect(refused.lines).toEqual(["No dev login is seeded. Run pithy seed, then press l again."]);
  });

  test("names no claim in any refusal, for any record", () => {
    for (const value of ["nobody@example.com", "example-1", ""]) {
      for (const line of selectDevLogin(many(3), NOW2, value).lines) expect(line).not.toContain(CLAIM);
    }
  });
});

describe("pickDevLoginByKey", () => {
  test("maps the digit a person pressed to the identity that digit named", () => {
    const live = usableDevLogins(many(3), NOW2);
    expect(pickDevLoginByKey(live, "1")?.email).toBe("user1@example.com");
    expect(pickDevLoginByKey(live, "3")?.email).toBe("user3@example.com");
  });

  test("is undefined for a digit past the list, and for anything that is not one", () => {
    // Every other key stays unbound: `l` is offered, a number in range is a choice, and nothing else is
    // a keypress this feature claims.
    const live = usableDevLogins(many(3), NOW2);
    for (const key of ["4", "0", "9", "a", "", "10"]) expect(pickDevLoginByKey(live, key)).toBeUndefined();
  });
});

describe("devLoginChoiceLines", () => {
  test("numbers the identities and names the range, and prints no claim", () => {
    const live = usableDevLogins(many(3), NOW2);
    expect(devLoginChoiceLines(live)).toEqual([
      "Which identity? Press 1–3.",
      "  1  user1@example.com",
      "  2  user2@example.com",
      "  3  user3@example.com",
    ]);
  });
});

// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { env } from "cloudflare:test";
import { MAX_USER_LOOKUP } from "@pithy-sh/auth/src/admin/users";
import { type AuthDatabase, authDatabase } from "@pithy-sh/auth/src/data/tables";
import { AUTH_MIGRATION_ORDER, auth_0001_init } from "@pithy-sh/auth/src/migrations/0001_init";
import { createMigrationRegistry } from "@pithy-sh/core/src/migrations/registry";
import { runMigrations } from "@pithy-sh/core/src/migrations/runner";
import type { MigrationProvider } from "kysely/migration";
import { beforeEach, describe, expect, test } from "vitest";
import { asPerson, memberImagePath, readPeople, readRoster } from "./people";

/**
 * The roster, against a real `pithy_auth_users` — because the property under test is what the auth
 * capability's own reader returns, and a mocked one would return whatever this file asked it to.
 *
 * Two things here cannot be demonstrated any other way. The **chunking** only matters past a cap that a
 * real statement imposes, so a fake `getUsers` would pass a roster of 150 through in one call and prove
 * nothing. And the **projection** is only a projection against a table that holds more columns than it
 * returns: `pithy_auth_accounts` sits beside the users table carrying live provider credentials, and the
 * test that matters is that a roster built this way cannot carry one however the join is later edited —
 * because there is no join.
 */

const NOW = new Date("2026-06-10T12:00:00.000Z");

const TABLES = [
  "pithy_auth_accounts",
  "pithy_auth_devices",
  "pithy_auth_jwks",
  "pithy_auth_rate_limit",
  "pithy_auth_rotated_tokens",
  "pithy_auth_sessions",
  "pithy_auth_users",
  "pithy_auth_verifications",
  "pithy_migrations",
  "pithy_migrations_lock",
];

function provider(): MigrationProvider {
  const registry = createMigrationRegistry([
    { database: "app", namespace: "auth", order: AUTH_MIGRATION_ORDER, migrations: { "0001_init": auth_0001_init } },
  ]);
  const found = registry.app;
  if (!found) throw new Error('expected a provider for database "app"');
  return found;
}

function db(): AuthDatabase {
  return authDatabase(env.DB);
}

/** One person in `pithy_auth_users`. Written raw, because the writer is Better Auth's and not ours. */
async function seedUser(
  id: string,
  fields: { name?: string; email?: string; image?: string | null; updatedAt?: Date } = {},
): Promise<void> {
  await env.DB.prepare(
    "insert into pithy_auth_users (id, name, email, email_verified, image, locale, created_at, updated_at) values (?, ?, ?, 1, ?, null, ?, ?)",
  )
    .bind(
      id,
      fields.name ?? `Person ${id}`,
      fields.email ?? `${id}@example.com`,
      fields.image ?? null,
      NOW.toISOString(),
      (fields.updatedAt ?? NOW).toISOString(),
    )
    .run();
}

/** A membership subject, as the roster read takes them. */
function subject(id: string, userId: string): { id: string; userId: string } {
  return { id, userId };
}

const BASE = "/organizations";

beforeEach(async () => {
  for (const table of TABLES) {
    await env.DB.prepare(`drop table if exists ${table}`).run();
  }
  await runMigrations(env.DB, provider());
});

describe("readRoster", () => {
  test("returns one row per membership, in the order it was given", async () => {
    await seedUser("u-ada", { name: "Ada", email: "ada@example.com" });
    await seedUser("u-bo", { name: "Bo", email: "bo@example.com" });

    const roster = await readRoster(db(), [subject("m-2", "u-bo"), subject("m-1", "u-ada")], BASE);

    // The caller holds the sort — by role, by join date, by name — and this read has no opinion about any
    // of them. What it guarantees is that the list back is the list in.
    expect(roster.map((person) => person.membershipId)).toEqual(["m-2", "m-1"]);
    expect(roster.map((person) => person.name)).toEqual(["Bo", "Ada"]);
    expect(roster.map((person) => person.email)).toEqual(["bo@example.com", "ada@example.com"]);
  });

  test("a membership whose person is gone is still a row, with the gap drawn", async () => {
    await seedUser("u-ada", { name: "Ada" });

    const roster = await readRoster(db(), [subject("m-1", "u-ada"), subject("m-2", "u-vanished")], BASE);

    // A membership can outlive the user row it names, and a roster is the only surface from which somebody
    // can then remove it. Failing the screen would make the one repair path unreachable.
    expect(roster).toHaveLength(2);
    expect(roster[1]).toEqual({
      membershipId: "m-2",
      userId: "u-vanished",
      name: null,
      email: null,
      image: null,
      imageInline: false,
    });
  });

  test("more people than one statement can bind still come back complete", async () => {
    // `getUsers` refuses past its cap rather than truncating, which is the right call for a library and the
    // wrong answer to serve a roster with. Here the cap is a chunk size, so an account larger than it gets
    // a complete list rather than a refusal — and quietly answering for 100 of 150 would be a wrong roster
    // presented as a right one.
    const size = MAX_USER_LOOKUP + 50;
    const subjects: { id: string; userId: string }[] = [];
    for (let at = 0; at < size; at += 1) {
      await seedUser(`u-${at}`, { name: `Person ${at}` });
      subjects.push(subject(`m-${at}`, `u-${at}`));
    }

    const roster = await readRoster(db(), subjects, BASE);

    expect(roster).toHaveLength(size);
    expect(roster.every((person) => person.name !== null)).toBe(true);
    expect(roster[MAX_USER_LOOKUP]?.name).toBe(`Person ${MAX_USER_LOOKUP}`);
  });

  test("an empty roster asks the database nothing", async () => {
    expect(await readRoster(db(), [], BASE)).toEqual([]);
    expect((await readPeople(db(), [])).size).toBe(0);
  });

  test("a provider's access token cannot reach a roster, because there is no join that could carry it", async () => {
    // `pithy_auth_accounts` holds live credentials against a third party on the person's behalf. A
    // hand-written roster join is one `selectAll` and one added `innerJoin` away from carrying them to a
    // screen; going through the auth capability's published reader means the projection is the `User`
    // schema, so nothing that table later gains arrives here unannounced.
    await seedUser("u-ada", { name: "Ada" });
    await env.DB.prepare(
      "insert into pithy_auth_accounts (id, issuer, account_id, provider_id, user_id, access_token, refresh_token, id_token, created_at, updated_at) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    )
      .bind(
        "acct-1",
        "https://accounts.google.com",
        "google-ada",
        "google",
        "u-ada",
        "ya29.SECRET-ACCESS-TOKEN",
        "1//SECRET-REFRESH-TOKEN",
        "eyJ.SECRET-ID-TOKEN",
        NOW.toISOString(),
        NOW.toISOString(),
      )
      .run();

    const roster = await readRoster(db(), [subject("m-1", "u-ada")], BASE);

    const rendered = JSON.stringify(roster);
    for (const secret of ["SECRET-ACCESS-TOKEN", "SECRET-REFRESH-TOKEN", "SECRET-ID-TOKEN"]) {
      expect(rendered).not.toContain(secret);
    }
    // And the row carries exactly the declared fields, so a column added upstream cannot appear here by
    // spreading.
    expect(Object.keys(roster[0] ?? {}).sort()).toEqual([
      "email",
      "image",
      "imageInline",
      "membershipId",
      "name",
      "userId",
    ]);
  });
});

describe("the face a roster draws", () => {
  const RASTER = `data:image/png;base64,${"A".repeat(64)}`;
  const VECTOR = `data:image/svg+xml;base64,${"B".repeat(64)}`;

  test("a stored raster becomes a versioned URL keyed by the membership, never by the person", async () => {
    await seedUser("u-ada", { image: RASTER });
    const roster = await readRoster(db(), [subject("m-1", "u-ada")], BASE);

    // Keyed by the membership, which is how entitlement is answered: the route resolves it inside the
    // acting organization, so an id from another account is the same 404 as one that never existed. A path
    // carrying the user id would be a question this capability cannot answer — *may this caller see this
    // person* — asked of a table it does not own.
    expect(roster[0]?.image).toBe(`${memberImagePath(BASE, "m-1")}?v=${NOW.getTime()}`);
    expect(roster[0]?.image).toContain("/members/m-1/image");
    expect(roster[0]?.image).not.toContain("u-ada");
    // A URL, not bytes: a roster costs one request per face once, rather than its bytes on every read.
    expect(roster[0]?.imageInline).toBe(false);
  });

  test("the version moves when the person's row does, so the URL may be served immutable", async () => {
    const later = new Date("2026-07-01T00:00:00.000Z");
    await seedUser("u-ada", { image: RASTER, updatedAt: later });
    const roster = await readRoster(db(), [subject("m-1", "u-ada")], BASE);
    expect(roster[0]?.image).toBe(`${memberImagePath(BASE, "m-1")}?v=${later.getTime()}`);
  });

  test("a stored vector stays inline and is never given a URL", async () => {
    await seedUser("u-ada", { image: VECTOR });
    const roster = await readRoster(db(), [subject("m-1", "u-ada")], BASE);

    // An `<img src>` is inert by specification; a URL is navigable, and a navigated SVG runs script in the
    // origin that served it. There is no arrangement of ids and versions that makes this origin return one.
    expect(roster[0]?.image).toBe(VECTOR);
    expect(roster[0]?.image).not.toContain("/members/");
    expect(roster[0]?.imageInline).toBe(true);
  });

  test("a provider's link passes through unchanged", async () => {
    // The shape the column was born holding, and refusing it would break every row written at a social
    // sign-in. It is already a URL and already cached by somebody else; there is nothing this origin can
    // add to it, so it is not rewritten into one of ours.
    await seedUser("u-ada", { image: "https://lh3.googleusercontent.com/a/ada" });
    const roster = await readRoster(db(), [subject("m-1", "u-ada")], BASE);
    expect(roster[0]?.image).toBe("https://lh3.googleusercontent.com/a/ada");
    expect(roster[0]?.imageInline).toBe(false);
  });

  test("nobody's face is nothing, and a caller draws initials", async () => {
    await seedUser("u-ada", { image: null });
    const roster = await readRoster(db(), [subject("m-1", "u-ada")], BASE);
    // Null rather than a placeholder URL. Initials are a real answer; a broken image is not.
    expect(roster[0]?.image).toBeNull();
    expect(roster[0]?.imageInline).toBe(false);
  });

  test("asPerson is the same projection, so a caller that already holds the user does not query again", () => {
    // Exported because a roster is not the only surface: an invitation flow already holds the person it is
    // about. One projection, so "who is in this organization" cannot come to mean two slightly different
    // things.
    const user = {
      id: "u-ada",
      name: "Ada",
      email: "ada@example.com",
      emailVerified: true,
      image: RASTER,
      locale: null,
      createdAt: NOW,
      updatedAt: NOW,
    };
    expect(asPerson(subject("m-1", "u-ada"), user, BASE)).toEqual({
      membershipId: "m-1",
      userId: "u-ada",
      name: "Ada",
      email: "ada@example.com",
      image: `${memberImagePath(BASE, "m-1")}?v=${NOW.getTime()}`,
      imageInline: false,
    });
  });
});

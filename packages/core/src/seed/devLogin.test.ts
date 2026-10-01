// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { describe, expect, test } from "vitest";
import {
  DEV_LOGIN_CLAIM_PARAM,
  DEV_LOGIN_FILE,
  DEV_LOGIN_PATH,
  DEV_LOGIN_ROUTE,
  DevLogin,
  DevLogins,
  SEED_ARTIFACT_DIR,
} from "./devLogin";

describe("DevLogin", () => {
  const onDisk = {
    email: "ada@example.com",
    userId: "example-ada",
    claim: "cGF5bG9hZA%3D%3D.signature",
    expiresAt: "2027-01-01T00:00:00.000Z",
  };

  test("round-trips through the JSON the seed writes and the banner reads", () => {
    const decoded = DevLogin.parse(onDisk);
    expect(decoded.expiresAt).toBeInstanceOf(Date);
    expect(decoded.email).toBe("ada@example.com");
    expect(DevLogin.encode(decoded)).toEqual(onDisk);
  });

  test("rejects a file missing the claim the route exists to exchange", () => {
    const { claim: _dropped, ...without } = onDisk;
    expect(DevLogin.safeParse(without).success).toBe(false);
  });

  test("the claim parameter is one spelling, shared by the route and the CLI that opens it", () => {
    // Same reason as the route below: `@pithy-sh/auth` reads it off the query and `pithy dev` writes it
    // into the URL, and neither may import the other. A second spelling is a keypress that 404s.
    expect(DEV_LOGIN_CLAIM_PARAM).toBe("t");
  });

  test("the artifact path stays under the gitignored logs directory", () => {
    expect(SEED_ARTIFACT_DIR).toBe("logs");
    expect(DEV_LOGIN_PATH).toBe(`logs/${DEV_LOGIN_FILE}`);
  });

  test("the route is absolute and reserved — one spelling, two packages", () => {
    // `@pithy-sh/auth` registers it and `pithy dev` opens it, and neither may import the other. A second
    // spelling in one of them is a keypress that opens a 404.
    expect(DEV_LOGIN_ROUTE).toBe("/__pithy/dev-login");
    expect(DEV_LOGIN_ROUTE.startsWith("/__pithy/")).toBe(true);
  });
});

describe("DevLogins", () => {
  const ada = {
    email: "ada@example.com",
    userId: "example-ada",
    claim: "YWRh%3D.signature",
    expiresAt: "2027-01-01T00:00:00.000Z",
  };
  const grace = {
    email: "grace@example.com",
    userId: "example-grace",
    claim: "Z3JhY2U%3D.signature",
    expiresAt: "2027-01-01T00:00:00.000Z",
  };

  test("round-trips the record the seed writes, keyed by user id", () => {
    const onDisk = { "example-ada": ada, "example-grace": grace };
    const decoded = DevLogins.parse(onDisk);
    expect(Object.keys(decoded)).toEqual(["example-ada", "example-grace"]);
    expect(decoded["example-grace"]?.expiresAt).toBeInstanceOf(Date);
    expect(DevLogins.encode(decoded)).toEqual(onDisk);
  });

  test("keeps the order the seed wrote, because that is the order the picker offers", () => {
    // The record's own insertion order is the only ordering there is, and `l` lists identities in it. A
    // parse that rebuilt the object would reorder somebody's picker between reseeds for no reason.
    expect(Object.keys(DevLogins.parse({ "example-grace": grace, "example-ada": ada }))).toEqual([
      "example-grace",
      "example-ada",
    ]);
  });

  test("an entry missing the claim takes the whole file down rather than half-loading", () => {
    const { claim: _dropped, ...without } = grace;
    expect(DevLogins.safeParse({ "example-ada": ada, "example-grace": without }).success).toBe(false);
  });

  test("**the single-entry file this replaced does not parse** — no migration, just reseed", () => {
    // `#667`. The old artifact was one `DevLogin` at the top level, so its fields are strings where an
    // entry belongs. It is gitignored and transient, so the degradation is the whole migration plan: the
    // reader answers "no dev login" and the banner stays quiet until `pithy seed` runs again.
    expect(DevLogins.safeParse(ada).success).toBe(false);
  });
});

// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { mkdtempSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PithyError } from "@pithy-sh/core/src/error/pithyError";
import { describe, expect, test } from "vitest";
import {
  type CloudflareSession,
  deleteSession,
  readSessionSync,
  sessionExpiresWithin,
  sessionPath,
  writeSession,
} from "./store";

function configDir(): { env: NodeJS.ProcessEnv } {
  return { env: { PITHY_CONFIG_DIR: mkdtempSync(join(tmpdir(), "pithy-session-")) } };
}

const SESSION: CloudflareSession = {
  profile: "pithy",
  accountId: "602df2e6ce74e98b4c7ac5e90a3af5c8",
  accountName: "pithy.",
  email: "jim@pithy.sh",
  accessToken: "AT",
  refreshToken: "RT",
  expiresAt: "2026-10-15T13:00:00.000Z",
  scope: "user-details.read offline_access",
};

describe("the session file", () => {
  test("is <config>/session.<profile>.json — at the config root, never under a project", () => {
    const options = configDir();
    expect(sessionPath("pithy", options)).toBe(join(options.env.PITHY_CONFIG_DIR ?? "", "session.pithy.json"));
  });

  test("round-trips, and is written 0600 because it holds a live credential", async () => {
    const options = configDir();
    await writeSession(SESSION, options);
    expect(readSessionSync("pithy", options)).toEqual(SESSION);
    if (process.platform !== "win32") expect(statSync(sessionPath("pithy", options)).mode & 0o777).toBe(0o600);
  });

  test("an absent file is no session, not an error", () => {
    expect(readSessionSync("pithy", configDir())).toBeNull();
  });

  test("a file that is not a session reads as none, rather than half of one", () => {
    const options = configDir();
    writeFileSync(sessionPath("pithy", options), JSON.stringify({ accessToken: "AT" }));
    expect(readSessionSync("pithy", options)).toBeNull();
  });

  test("delete removes it and says whether there was one", async () => {
    const options = configDir();
    await writeSession(SESSION, options);
    expect(await deleteSession("pithy", options)).toBe(true);
    expect(readSessionSync("pithy", options)).toBeNull();
    expect(await deleteSession("pithy", options)).toBe(false);
  });

  test("a profile name that would leave the config directory is refused where the path is built", () => {
    // The name becomes a file name, so it is held to the rule `cloudflare.<accountName>.json` is held to.
    for (const bad of ["../x", "a/b", "", "A", "a b"]) {
      expect(() => sessionPath(bad, configDir()), bad).toThrow(PithyError);
    }
  });
});

describe("sessionExpiresWithin", () => {
  const now = new Date("2026-10-15T12:56:00.000Z");

  test("is true inside the margin and false outside it", () => {
    expect(sessionExpiresWithin(SESSION, 5 * 60_000, now)).toBe(true);
    expect(sessionExpiresWithin(SESSION, 60_000, now)).toBe(false);
  });

  test("an expiry already past is within any margin", () => {
    expect(sessionExpiresWithin(SESSION, 0, new Date("2026-10-15T14:00:00.000Z"))).toBe(true);
  });
});

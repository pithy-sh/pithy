// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { describe, expect, test } from "vitest";
import { DEV_LOGIN_FILE, DEV_LOGIN_PATH, DevLogin, SEED_ARTIFACT_DIR } from "./devLogin";

describe("DevLogin", () => {
  const onDisk = {
    email: "ada@example.com",
    userId: "example-ada",
    cookieName: "better-auth.session_token",
    cookieValue: "token.signature",
    expiresAt: "2027-01-01T00:00:00.000Z",
  };

  test("round-trips through the JSON the seed writes and the banner reads", () => {
    const decoded = DevLogin.parse(onDisk);
    expect(decoded.expiresAt).toBeInstanceOf(Date);
    expect(decoded.email).toBe("ada@example.com");
    expect(DevLogin.encode(decoded)).toEqual(onDisk);
  });

  test("rejects a file missing the cookie the banner exists to hand over", () => {
    const { cookieValue: _dropped, ...without } = onDisk;
    expect(DevLogin.safeParse(without).success).toBe(false);
  });

  test("the artifact path stays under the gitignored logs directory", () => {
    expect(SEED_ARTIFACT_DIR).toBe("logs");
    expect(DEV_LOGIN_PATH).toBe(`logs/${DEV_LOGIN_FILE}`);
  });
});

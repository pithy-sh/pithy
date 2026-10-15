// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { mkdirSync, mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { bindProfile } from "./bindings";
import { isBoundSessionToken, sessionTokenProvider } from "./kind";
import { writeSession } from "./store";

describe("isBoundSessionToken", () => {
  test("is true for the bound session's access token, and false for any other token or directory", async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "pithy-kind-")));
    const env = { PITHY_CONFIG_DIR: join(root, "config") };
    const cwd = join(root, "project");
    mkdirSync(cwd);
    await bindProfile(cwd, "pithy", { env });
    await writeSession(
      {
        profile: "pithy",
        accountId: "acct",
        accountName: null,
        email: null,
        accessToken: "AT",
        refreshToken: null,
        expiresAt: "2026-10-15T13:00:00.000Z",
        scope: "s",
      },
      { env },
    );
    expect(isBoundSessionToken("AT", { cwd, env })).toBe(true);
    expect(isBoundSessionToken("cfat_somebody-elses", { cwd, env })).toBe(false);
    expect(isBoundSessionToken("AT", { cwd: root, env })).toBe(false);
  });

  test("a provider for the session's token answers the current token after a renewal; any other token gets none", async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "pithy-kind-")));
    const env = { PITHY_CONFIG_DIR: join(root, "config") };
    const cwd = join(root, "project");
    mkdirSync(cwd);
    await bindProfile(cwd, "pithy", { env });
    const session = {
      profile: "pithy",
      accountId: "acct",
      accountName: null,
      email: null,
      accessToken: "AT1",
      refreshToken: "RT",
      expiresAt: "2026-10-15T13:00:00.000Z",
      scope: "s",
    };
    await writeSession(session, { env });
    const provider = sessionTokenProvider("AT1", { cwd, env });
    expect(provider?.()).toBe("AT1");
    await writeSession({ ...session, accessToken: "AT2" }, { env });
    expect(provider?.()).toBe("AT2");
    expect(sessionTokenProvider("cfat_account", { cwd, env })).toBeUndefined();
    // Signed in to another account under the same profile mid-run: the client keeps its last token.
    await writeSession({ ...session, accountId: "another-account", accessToken: "AT9" }, { env });
    expect(provider?.()).toBe("AT2");
    // Rebound to another profile here mid-run: still this profile's session, not the new binding's.
    await writeSession({ ...session, profile: "other", accessToken: "OTHER" }, { env });
    await bindProfile(cwd, "other", { env });
    expect(provider?.()).toBe("AT2");
  });
});

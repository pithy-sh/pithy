// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { mkdirSync, mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RefreshResult } from "@pithy-sh/cloudflare/src/oauth/client";
import { describe, expect, test } from "vitest";
import { cloudflareEnv } from "../config";
import { bindProfile } from "./bindings";
import { freshenBoundSession } from "./dispatch";
import { writeSession } from "./store";

const NOW = new Date("2026-10-15T12:00:00.000Z");

async function boundAndExpired(): Promise<{ cwd: string; env: NodeJS.ProcessEnv }> {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "pithy-dispatch-")));
  const env = { PITHY_CONFIG_DIR: join(root, "config") };
  const cwd = join(root, "project");
  mkdirSync(cwd);
  await bindProfile(cwd, "pithy", { env });
  await writeSession(
    {
      profile: "pithy",
      accountId: "acct",
      accountName: null,
      email: "jim@pithy.sh",
      accessToken: "AT-expired",
      refreshToken: "RT1",
      expiresAt: "2026-10-15T11:00:00.000Z",
      scope: "s",
    },
    { env },
  );
  return { cwd, env };
}

const renewing = async (): Promise<RefreshResult> => ({
  kind: "refreshed",
  grant: { accessToken: "AT-fresh", refreshToken: "RT2", expiresAt: new Date("2026-10-15T13:00:00.000Z"), scope: "s" },
});

describe("freshenBoundSession — what dispatch runs before any command body", () => {
  test("an expired session bound here is renewed first, so the command's credential read sees the fresh token", async () => {
    const { cwd, env } = await boundAndExpired();
    expect(() => cloudflareEnv({ account: null, env, cwd, now: () => NOW })).toThrow(/expired/);
    expect((await freshenBoundSession({ cwd, env, now: () => NOW, refresh: renewing }))?.kind).toBe("refreshed");
    expect(cloudflareEnv({ account: null, env, cwd, now: () => NOW }).CLOUDFLARE_API_TOKEN).toBe("AT-fresh");
  });

  test("nothing bound here is nothing to do, and costs no call", async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "pithy-dispatch-")));
    let called = false;
    const result = await freshenBoundSession({
      cwd: root,
      env: { PITHY_CONFIG_DIR: join(root, "config") },
      now: () => NOW,
      refresh: async () => {
        called = true;
        return renewing();
      },
    });
    expect(result).toBeNull();
    expect(called).toBe(false);
  });

  test("offline renews nothing: PITHY_OFFLINE means nothing over the wire", async () => {
    const { cwd, env } = await boundAndExpired();
    let called = false;
    await freshenBoundSession({
      cwd,
      env: { ...env, PITHY_OFFLINE: "1" },
      now: () => NOW,
      refresh: async () => {
        called = true;
        return renewing();
      },
    });
    expect(called).toBe(false);
  });

  test("a renewal that fails never stops dispatch: the command that needs Cloudflare refuses, and no other", async () => {
    const { cwd, env } = await boundAndExpired();
    const result = await freshenBoundSession({
      cwd,
      env,
      now: () => NOW,
      refresh: async () => {
        throw new Error("network down");
      },
    });
    expect(result).toBeNull();
  });
});

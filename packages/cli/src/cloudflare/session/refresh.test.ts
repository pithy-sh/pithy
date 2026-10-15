// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RefreshResult } from "@pithy-sh/cloudflare/src/oauth/client";
import { describe, expect, test } from "vitest";
import { ensureFreshSession, REFRESH_MARGIN_MS, replaceSession, SIGN_IN_LOCK_BUDGET } from "./refresh";
import { type CloudflareSession, readSessionSync, writeSession } from "./store";

const NOW = new Date("2026-10-15T12:00:00.000Z");

function configDir(): { env: NodeJS.ProcessEnv } {
  return { env: { PITHY_CONFIG_DIR: mkdtempSync(join(tmpdir(), "pithy-refresh-")) } };
}

function session(expiresAt: string, refreshToken: string | null = "RT1"): CloudflareSession {
  return {
    profile: "pithy",
    accountId: "acct",
    accountName: null,
    email: "jim@pithy.sh",
    accessToken: "AT1",
    refreshToken,
    expiresAt,
    scope: "s",
  };
}

/** A refresh that rotates RT1 → RT2 and counts its calls, optionally slowly. */
function rotating(delayMs = 0): ((args: { refreshToken: string }) => Promise<RefreshResult>) & { calls: string[] } {
  const calls: string[] = [];
  const fn = async ({ refreshToken }: { refreshToken: string }): Promise<RefreshResult> => {
    calls.push(refreshToken);
    await new Promise((resolve) => setTimeout(resolve, delayMs));
    return {
      kind: "refreshed",
      grant: { accessToken: "AT2", refreshToken: "RT2", expiresAt: new Date("2026-10-15T13:00:00.000Z"), scope: "s" },
    };
  };
  return Object.assign(fn, { calls });
}

describe("ensureFreshSession", () => {
  test("a session outside the margin is left alone and costs no call", async () => {
    const options = configDir();
    await writeSession(session("2026-10-15T12:30:00.000Z"), options);
    const refresh = rotating();
    expect(await ensureFreshSession("pithy", { ...options, now: () => NOW, refresh })).toEqual({ kind: "fresh" });
    expect(refresh.calls).toEqual([]);
  });

  test("a session inside the margin is renewed, and the rotated refresh token replaces the spent one on disk", async () => {
    const options = configDir();
    await writeSession(session(new Date(NOW.getTime() + REFRESH_MARGIN_MS - 1_000).toISOString()), options);
    const refresh = rotating();
    const result = await ensureFreshSession("pithy", { ...options, now: () => NOW, refresh });
    expect(result.kind).toBe("refreshed");
    expect(readSessionSync("pithy", options)).toMatchObject({
      accessToken: "AT2",
      refreshToken: "RT2",
      expiresAt: "2026-10-15T13:00:00.000Z",
    });
  });

  test("two refreshes at once produce exactly one rotation, and the second uses what the first wrote", async () => {
    // The lock, re-reading under it: without both, each process sends RT1 and writes its own answer over
    // the other's. Cloudflare accepted a spent token within a second (measured), so the race would not
    // sign anyone out today — it would leave two writers racing one file, which is reason enough.
    const options = configDir();
    await writeSession(session("2026-10-15T11:59:00.000Z"), options);
    const refresh = rotating(40);
    const [a, b] = await Promise.all([
      ensureFreshSession("pithy", { ...options, now: () => NOW, refresh, lockBudget: { retryDelayMs: 5 } }),
      ensureFreshSession("pithy", { ...options, now: () => NOW, refresh, lockBudget: { retryDelayMs: 5 } }),
    ]);
    expect(refresh.calls).toEqual(["RT1"]);
    expect([a.kind, b.kind].sort()).toEqual(["fresh", "refreshed"]);
    expect(readSessionSync("pithy", options)?.refreshToken).toBe("RT2");
  });

  test("a refused refresh leaves the file as it was and says so, so the next command asks for a sign-in", async () => {
    const options = configDir();
    await writeSession(session("2026-10-15T11:59:00.000Z"), options);
    const refresh = async (): Promise<RefreshResult> => ({
      kind: "refused",
      error: "invalid_grant",
      description: "The refresh token is malformed or not valid.",
    });
    expect(await ensureFreshSession("pithy", { ...options, now: () => NOW, refresh })).toEqual({
      kind: "refused",
      description: "The refresh token is malformed or not valid.",
    });
    expect(readSessionSync("pithy", options)?.refreshToken).toBe("RT1");
  });

  test("a stale session with no refresh token cannot be renewed, and says that rather than calling out", async () => {
    const options = configDir();
    await writeSession(session("2026-10-15T11:59:00.000Z", null), options);
    const refresh = rotating();
    expect(await ensureFreshSession("pithy", { ...options, now: () => NOW, refresh })).toEqual({
      kind: "no-refresh-token",
    });
    expect(refresh.calls).toEqual([]);
  });

  test("no session is nothing to do", async () => {
    expect(await ensureFreshSession("pithy", { ...configDir(), now: () => NOW, refresh: rotating() })).toEqual({
      kind: "none",
    });
  });

  test("a sign-in written while a renewal is in flight is the one left on disk, never reverted by it", async () => {
    // The renewal holds the lock while it waits on the token endpoint. The new sign-in waits for it, then
    // replaces it — rather than landing first and being overwritten with the old account's renewed tokens.
    const options = configDir();
    await writeSession(session("2026-10-15T11:59:00.000Z"), options);
    const renewing = ensureFreshSession("pithy", {
      ...options,
      now: () => NOW,
      refresh: rotating(40),
      lockBudget: { retryDelayMs: 5 },
    });
    await new Promise((resolve) => setTimeout(resolve, 10));
    const signingIn = replaceSession(
      { ...session("2026-10-15T13:00:00.000Z"), accountId: "account-b", accessToken: "AT-B", refreshToken: "RT-B" },
      { ...options, lockBudget: { retryDelayMs: 5 } },
    );
    await Promise.all([renewing, signingIn]);
    expect(readSessionSync("pithy", options)).toMatchObject({ accountId: "account-b", accessToken: "AT-B" });
  });

  test("a sign-in waits longer for the lock than a token-endpoint call may take, so it is never discarded", () => {
    const waited = (SIGN_IN_LOCK_BUDGET.maxAttempts ?? 0) * (SIGN_IN_LOCK_BUDGET.retryDelayMs ?? 0);
    expect(waited).toBeGreaterThan(30_000);
  });
});

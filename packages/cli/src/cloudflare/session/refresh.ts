// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { type RefreshResult, refreshGrant } from "@pithy-sh/cloudflare/src/oauth/client";
import { InternalError } from "@pithy-sh/core/src/error/pithyError";
import { ensureOwnerOnlyDirFor } from "../../devSecrets/mode";
import type { StatePathOptions } from "../../notifier/state";
import { type LockBudget, withFileLock } from "../../project/fileLock";
import { type CloudflareSession, readSessionSync, sessionExpiresWithin, sessionPath, writeSession } from "./store";

/**
 * How close to expiry a session is renewed. Five minutes: wide enough that a command started now finishes
 * inside the token it was handed, and narrow enough that almost every run of an hour-long token makes no
 * call at all.
 */
export const REFRESH_MARGIN_MS = 5 * 60_000;

/** What a freshness check did. */
export type Freshness =
  | { kind: "none" }
  | { kind: "fresh" }
  | { kind: "refreshed"; session: CloudflareSession }
  | { kind: "no-refresh-token" }
  | { kind: "refused"; description: string };

/** What {@link ensureFreshSession} takes beyond the profile. */
export interface EnsureFreshOptions extends StatePathOptions {
  /** The clock. Defaults to `() => new Date()`. */
  now?: () => Date;
  /** How close to expiry counts as stale. Defaults to {@link REFRESH_MARGIN_MS}. */
  marginMs?: number;
  /** The token-endpoint refresh. Defaults to `refreshGrant`; a test hands its own. */
  refresh?: (args: { refreshToken: string }) => Promise<RefreshResult>;
  /** How long to wait for the profile's lock. Defaults to the production budget. */
  lockBudget?: LockBudget;
}

/**
 * **Renew a profile's session if it expires within the margin — under the profile's lock, re-reading
 * under it (#759).**
 *
 * Refresh tokens rotate on every use, so a refresh is a read-modify-write of one file: send the stored
 * refresh token, store the one handed back. Two `pithy` processes doing that at once — `dev` in one
 * terminal, `deploy` in another — would each send the same token and each write its own answer over the
 * other's. So the check runs under an exclusive lock beside the session file, and it **re-reads** once it
 * holds it: when another process has already renewed, the session it finds is fresh, and this one uses
 * that rather than spending a second rotation.
 *
 * Cloudflare accepted a spent refresh token within a second of its rotation and the chain survived
 * (measured 2026-10-15), so losing that race would not sign anyone out today. The lock is required
 * anyway: it is what keeps two writers off one credential file.
 *
 * **A refusal is reported, never thrown, and the file is left as it was.** A dead refresh token means
 * *sign in again*, and dispatch does not stop a command that may never touch Cloudflare over it; the
 * credential seam refuses an expired session at the first command that does.
 */
export async function ensureFreshSession(profile: string, options: EnsureFreshOptions = {}): Promise<Freshness> {
  const now = options.now ?? (() => new Date());
  const margin = options.marginMs ?? REFRESH_MARGIN_MS;
  const before = readSessionSync(profile, options);
  if (before === null) return { kind: "none" };
  if (!sessionExpiresWithin(before, margin, now())) return { kind: "fresh" };

  const path = sessionPath(profile, options);
  await ensureOwnerOnlyDirFor(path);
  return withFileLock(
    path,
    async (): Promise<Freshness> => {
      const current = readSessionSync(profile, options);
      if (current === null) return { kind: "none" };
      if (!sessionExpiresWithin(current, margin, now())) return { kind: "fresh" };
      if (current.refreshToken === null) return { kind: "no-refresh-token" };
      const refresh = options.refresh ?? ((args: { refreshToken: string }) => refreshGrant({ ...args, now }));
      const result = await refresh({ refreshToken: current.refreshToken });
      if (result.kind === "refused") return { kind: "refused", description: result.description };
      const renewed: CloudflareSession = {
        ...current,
        accessToken: result.grant.accessToken,
        refreshToken: result.grant.refreshToken ?? current.refreshToken,
        expiresAt: result.grant.expiresAt.toISOString(),
        scope: result.grant.scope,
      };
      await writeSession(renewed, options);
      return { kind: "refreshed", session: renewed };
    },
    sessionLock(profile, options.lockBudget),
  );
}

/** The lock options every writer of one profile's session shares — the refresh, and a new sign-in. */
function sessionLock(profile: string, budget?: LockBudget) {
  return {
    budget,
    refusal: ({ lockPath, attempts }: { lockPath: string; attempts: number }) =>
      new InternalError({
        message: `Could not lock the Cloudflare session for profile ${profile}.`,
        action: `If no other pithy process is running, delete ${lockPath} by hand and retry.`,
        detail: `Timed out acquiring ${lockPath} after ${attempts} attempts.`,
      }),
  };
}

/**
 * Write a new sign-in's session **under the lock a refresh holds** (#759). Without it a renewal already in
 * flight — `pithy dev`'s keeper, a `deploy` in another terminal — reads the old session, waits on the
 * token endpoint, and writes the old account's renewed tokens over the sign-in that just replaced them.
 * With it, the renewal either finishes first and is replaced, or starts after and finds a fresh session.
 */
/**
 * How long a new sign-in waits for the session's lock: forty seconds, longer than the thirty a token-endpoint
 * call may take, so a renewal held up by a slow endpoint delays a sign-in and never discards it.
 */
export const SIGN_IN_LOCK_BUDGET: LockBudget = { maxAttempts: 400, retryDelayMs: 100 };

export async function replaceSession(
  session: CloudflareSession,
  options: StatePathOptions & { lockBudget?: LockBudget } = {},
): Promise<void> {
  const path = sessionPath(session.profile, options);
  await ensureOwnerOnlyDirFor(path);
  await withFileLock(
    path,
    () => writeSession(session, options),
    sessionLock(session.profile, options.lockBudget ?? SIGN_IN_LOCK_BUDGET),
  );
}

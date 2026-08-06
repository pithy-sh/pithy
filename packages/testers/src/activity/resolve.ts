// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import type { D1Database } from "@cloudflare/workers-types";
import { chunkByBoundParameters } from "@pithy-sh/core/src/data/boundParameters";
import { JsonDate } from "@pithy-sh/core/src/data/codecs";
import { messageOf } from "@pithy-sh/core/src/error/pithyError";
import { type Logger, noopLogger } from "@pithy-sh/core/src/logger/logger";
import type { TesterPlatform } from "../config/config";
import type { ActivityState, Observability } from "../data/enums";

/**
 * Reading what testers actually did — the only figures in this package that are fact rather than
 * estimate.
 *
 * **Activity is not a proxy for opt-in continuity, and conflating them would be the worst mistake this
 * capability could make.** A tester who confirmed and never opens the app still counts toward Google's
 * twelve. What activity buys is the only early-warning signal available: a tester dark for eight days
 * is the one most likely to have quietly opted out or uninstalled, and that is actionable on day eight
 * rather than on day fourteen when the count finally moves. So this module scores worry, never
 * membership.
 *
 * **`@pithy-sh/auth` is an optional peer, reached through a guarded dynamic import.** A static import
 * would make auth a hard dependency of a capability that works without it: a project whose test flow
 * has no sign-in gets no activity data and should still be able to run cohorts, send invitations, and
 * track the clock. When auth is absent, every tester resolves `unobservable` and the forecast widens
 * its band to say so — which is exactly the right answer, and a much better one than failing to boot.
 *
 * **Two date encodings live in auth's own tables, and mixing them silently returns nothing.** Better
 * Auth's columns (`pithy_auth_sessions`) are ISO-8601 **text**; Pithy's own (`pithy_auth_devices`) are
 * ms-epoch **integers**. A window query written with the wrong codec compares a number to a string,
 * matches no rows, and reports a perfectly active cohort as entirely dark. `JsonDate` for the first,
 * `SQLiteDate` for the second — the comments at each call site say which and why.
 */

/** One registered device, as the roster view reports it. */
export interface TesterDevice {
  readonly platform: TesterPlatform | "web";
  readonly lastSeenAt: Date;
  readonly appVersion: string | null;
}

/** What we can observe about one tester. Every field here is fact; none of it is inferred. */
export interface TesterActivity {
  /** The invited address this reading is for, lowercased. */
  readonly email: string;
  /** The matched user's id, or null when the address never matched a user. */
  readonly userId: string | null;
  /** Whether we can see this tester at all, and why not when we cannot. */
  readonly observability: Observability;
  /** What the activity says. `never_linked` is deliberately distinct from `inactive`. */
  readonly state: ActivityState;
  /** The most recent sign of life — session refresh or device sighting. Null when never linked. */
  readonly lastAuthenticatedAt: Date | null;
  /** Sessions *active* inside the requested window — refreshed within it, whenever they were created. */
  readonly sessionsInWindow: number;
  /** Registered devices, most recently seen first. */
  readonly devices: readonly TesterDevice[];
}

/** What the reader needs to know to interpret what it finds. */
export interface ActivityOptions {
  /** The start of the window sessions are counted inside. */
  readonly since: Date;
  /** A tester who authenticated at or after this is `active`. */
  readonly activeSince: Date;
  /** Addresses known to have bounced or be suppressed — reported `unreachable` whatever else we find. */
  readonly unreachable: ReadonlySet<string>;
}

/** The auth modules this reader needs, or null when `@pithy-sh/auth` is not installed. */
type AuthModules = {
  authDatabase: typeof import("@pithy-sh/auth/src/data/tables").authDatabase;
  User: typeof import("@pithy-sh/auth/src/data/betterAuth").User;
  Device: typeof import("@pithy-sh/auth/src/data/device").Device;
} | null;

/**
 * Load `@pithy-sh/auth`, or `null` if it is not installed.
 *
 * A missing optional peer is not an error here — it is a project that has no sign-in, which is a
 * legitimate way to run a closed test. Returning null lets every tester resolve `unobservable`, which
 * is the honest reading, rather than raising in a daily Workflow nobody is watching.
 */
async function loadAuth(): Promise<AuthModules> {
  try {
    const [tables, betterAuth, device] = await Promise.all([
      import("@pithy-sh/auth/src/data/tables"),
      import("@pithy-sh/auth/src/data/betterAuth"),
      import("@pithy-sh/auth/src/data/device"),
    ]);
    return { authDatabase: tables.authDatabase, User: betterAuth.User, Device: device.Device };
  } catch {
    return null;
  }
}

/** A tester we cannot see, with the reason stated rather than implied. */
function blind(email: string, observability: Observability): TesterActivity {
  return {
    email,
    userId: null,
    observability,
    state: observability === "unreachable" ? "unreachable" : "never_linked",
    lastAuthenticatedAt: null,
    sessionsInWindow: 0,
    devices: [],
  };
}

/**
 * Resolve activity for a set of invited addresses.
 *
 * Batched by address rather than looked up one tester at a time: a hundred-member roster would
 * otherwise be three hundred round trips inside a Workflow step. `chunkByBoundParameters` keeps each
 * `IN (…)` inside D1's statement limits.
 *
 * **`log` is the caller's logger, not one built here, because this reader has two callers of different
 * shapes.** It runs inside the daily Workflow, and it runs inside `GET /testers/status` and
 * `GET /testers/cohorts` — so a request reaches it, and a request logger already carries the
 * correlation an operator needs. Building a fresh one here would emit the line that explains an empty
 * roster with nothing tying it to the request that asked for it. Defaults to the no-op so a caller with
 * no logger reads activity rather than null-checking.
 */
export async function resolveActivity(
  d1: D1Database,
  emails: readonly string[],
  options: ActivityOptions,
  log: Logger = noopLogger,
): Promise<Map<string, TesterActivity>> {
  const normalized = [...new Set(emails.map((email) => email.trim().toLowerCase()))];
  const results = new Map<string, TesterActivity>();
  for (const email of normalized) {
    results.set(email, blind(email, options.unreachable.has(email) ? "unreachable" : "unobservable"));
  }
  if (normalized.length === 0) return results;

  const auth = await loadAuth();
  if (!auth) return results;

  try {
    await readActivityInto(results, auth, d1, normalized, options);
  } catch (error) {
    // The auth tables are not there — the package is installed but its migration has not run, or this
    // project composes testers without composing auth. Either way it is the same fact as an uninstalled
    // package, and it must degrade the same way: every tester resolves `unobservable`, the forecast
    // widens its band to say so, and the daily pass still advances state and records the day. Throwing
    // here would take down a cron at 05:00 over data that was never promised to exist.
    //
    // Logged rather than silent, because the other thing this catch swallows is a transient D1 failure,
    // and that records a cohort as entirely dark for a day with no trace of why. An operator reading a
    // sudden coverage cliff needs somewhere to look. `warn` rather than `error`: the reading degraded,
    // the caller carried on, and a project that simply has no auth would otherwise page somebody.
    log.warn("activity unreadable, treating the roster as unobservable", {
      addresses: normalized.length,
      reason: messageOf(error),
    });
  }
  return results;
}

/** Fill in what the auth tables can tell us about these addresses. Throws if they are not there. */
async function readActivityInto(
  results: Map<string, TesterActivity>,
  auth: NonNullable<AuthModules>,
  d1: D1Database,
  normalized: readonly string[],
  options: ActivityOptions,
): Promise<void> {
  const db = auth.authDatabase(d1);

  // Address → user. Auth's `email` column is unique and every Pithy sign-in is provider-verified, so
  // this is an exact match with no ambiguity to resolve.
  const users: { id: string; email: string }[] = [];
  for (const chunk of chunkByBoundParameters(normalized, 0)) {
    const rows = await db.selectFrom("pithyAuthUsers").select(["id", "email"]).where("email", "in", chunk).execute();
    for (const row of rows) users.push({ id: String(row.id), email: String(row.email).toLowerCase() });
  }
  if (users.length === 0) return;

  const userIds = users.map((user) => user.id);
  const emailByUserId = new Map(users.map((user) => [user.id, user.email]));

  // Sessions in the window. `createdAt` is ISO-8601 TEXT on this table — Better Auth's own encoding —
  // so the bound must be `JsonDate`. `SQLiteDate` here would compare a number against a string, match
  // nothing, and report every tester as dark.
  const sessions = new Map<string, { count: number; lastSeen: Date | null }>();
  for (const chunk of chunkByBoundParameters(userIds, 1)) {
    const rows = await db
      .selectFrom("pithyAuthSessions")
      .select(["userId", "createdAt", "updatedAt"])
      .where("userId", "in", chunk)
      // Bounded on `updatedAt`, which is the column the reading below actually uses. Filtering on
      // `createdAt` excluded the long-lived session — created before the window, refreshed inside it
      // every day since — and reported its owner as dark. That is the most engaged tester there is.
      .where("updatedAt", ">=", JsonDate.encode(options.since))
      .execute();
    for (const row of rows) {
      const userId = String(row.userId);
      const entry = sessions.get(userId) ?? { count: 0, lastSeen: null };
      entry.count++;
      // `updatedAt` slides forward when a session is refreshed, so it is a genuine "last seen the app"
      // signal rather than "last signed in" — which token rotation would otherwise reset.
      const seen = JsonDate.parse(row.updatedAt ?? row.createdAt);
      if (!entry.lastSeen || seen > entry.lastSeen) entry.lastSeen = seen;
      sessions.set(userId, entry);
    }
  }

  // Devices. This is a Pithy-owned table, so `lastSeenAt` is a ms-epoch INTEGER and the codec is
  // `SQLiteDate`. Devices cover the tester whose long-lived session is refreshed off-device.
  const devices = new Map<string, TesterDevice[]>();
  for (const chunk of chunkByBoundParameters(userIds, 0)) {
    const rows = await db
      .selectFrom("pithyAuthDevices")
      .selectAll()
      .where("userId", "in", chunk)
      .orderBy("lastSeenAt", "desc")
      .execute();
    for (const row of rows) {
      const parsed = auth.Device.parse(row);
      const list = devices.get(parsed.userId) ?? [];
      list.push({ platform: parsed.platform, lastSeenAt: parsed.lastSeenAt, appVersion: parsed.appVersion });
      devices.set(parsed.userId, list);
    }
  }

  for (const [userId, email] of emailByUserId) {
    if (options.unreachable.has(email)) continue; // Unreachable overrides whatever we can see.

    const session = sessions.get(userId);
    const deviceList = devices.get(userId) ?? [];
    const lastDevice = deviceList[0]?.lastSeenAt ?? null;
    const lastSession = session?.lastSeen ?? null;
    const lastAuthenticatedAt =
      lastSession && lastDevice ? (lastSession > lastDevice ? lastSession : lastDevice) : (lastSession ?? lastDevice);

    // A user row with no session and no device is a match we cannot learn anything from. Calling it
    // `observed` would let a tester with zero signal score as merely quiet, when the truth is that we
    // have never seen them use the app at all.
    if (!lastAuthenticatedAt) {
      results.set(email, blind(email, "unobservable"));
      continue;
    }

    const state: ActivityState = lastAuthenticatedAt >= options.activeSince ? "active" : "inactive";
    results.set(email, {
      email,
      userId,
      observability: "observed",
      state,
      lastAuthenticatedAt,
      sessionsInWindow: session?.count ?? 0,
      devices: deviceList,
    });
  }
}

/** Whether any of a tester's devices runs the cohort's target platform. */
export function hasPlatformDevice(activity: TesterActivity, platform: TesterPlatform | null): boolean {
  if (platform === null) return true;
  return activity.devices.some((device) => device.platform === platform);
}

/** The most recent device sighting, for a tester whose sessions have all rotated away. */
export function lastDeviceSeen(activity: TesterActivity): Date | null {
  let latest: Date | null = null;
  for (const device of activity.devices) {
    if (!latest || device.lastSeenAt > latest) latest = device.lastSeenAt;
  }
  return latest;
}

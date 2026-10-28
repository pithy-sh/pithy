// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { controlPlaneToolName } from "@pithy-sh/core/src/controlPlane/discovery/toolName";
import { describe, expect, test } from "vitest";
import { kitComposition } from "../openapi/kitDocument";

/**
 * **Every kit admin route's operation, as published (#723, `docs/AGENT-ACCESS.md` §5).**
 *
 * An operation names an MCP tool — `<capability>_<operation>` — and an agent references a tool by name in prompts,
 * saved workflows and its own record of what worked. So once published an operation is permanent, and the property
 * is only true as a set: this table is every kit capability's admin surface, composed the way the kit's own
 * contract is, and it fails when an operation is renamed, dropped, moved to another route, or added without a row.
 *
 * **Adding a route is adding a row.** Renaming one is not something this table permits: a route that changes what
 * it does is a new operation, and the old name goes with the old route.
 */
const PUBLISHED: Readonly<Record<string, Readonly<Record<string, string>>>> = {
  controlplane: {
    ping: "GET /control-plane/ping",
    "manifest.read": "GET /control-plane/manifest",
    "keys.list": "GET /control-plane/keys",
    "keys.register": "POST /control-plane/keys",
    "keys.expire": "POST /control-plane/keys/:keyId/expire",
    "migrations.read": "GET /control-plane/migrations",
    "privacy.read": "GET /control-plane/privacy",
    "evidence.read": "GET /control-plane/evidence",
    "holds.list": "GET /control-plane/holds",
    "holds.place": "POST /control-plane/holds",
    "holds.release": "POST /control-plane/holds/:holdId/release",
    "erasure.list": "GET /control-plane/erasure",
    "erasure.read": "GET /control-plane/erasure/:subjectType/:subjectId",
    "presence.tickets.mint": "POST /control-plane/presence/tickets",
  },
  secrets: {
    "status.read": "GET /secrets/admin/status",
    "rotations.list": "GET /secrets/admin/status/:name/rotations",
    "secrets.rotate": "POST /secrets/admin/status/:name/rotate",
  },
  email: {
    "jobs.list": "GET /email/jobs",
    "jobs.read": "GET /email/jobs/:id",
    "jobs.retry": "POST /email/jobs/:id/retry",
    "suppressions.list": "GET /email/suppressions",
    "suppressions.add": "POST /email/suppressions",
    "suppressions.remove": "POST /email/suppressions/remove",
  },
  auth: {
    "users.list": "GET /auth/admin/users",
    "users.read": "GET /auth/admin/users/:userId",
    "devices.list": "GET /auth/admin/devices",
    "sessions.revoke": "POST /auth/admin/sessions/revoke",
    "users.sessions.revoke": "POST /auth/admin/users/:userId/sessions/revoke",
    "users.devices.revoke": "POST /auth/admin/users/:userId/devices/revoke",
    "users.suspend": "POST /auth/admin/users/:userId/suspend",
    "users.reinstate": "POST /auth/admin/users/:userId/reinstate",
    "users.delete": "DELETE /auth/admin/users/:userId",
    "users.restore": "POST /auth/admin/users/:userId/restore",
    "verifications.list": "GET /auth/admin/verifications",
    "users.export": "GET /auth/admin/users/:userId/export",
  },
  turnstile: {
    "widgets.list": "GET /turnstile/admin/widgets",
  },
  audit: {
    "events.list": "GET /audit/events",
    "access_history.read": "GET /audit/control-plane/access-history",
    "reach.read": "GET /audit/control-plane/reach",
    "usage.read": "GET /audit/control-plane/usage",
    "chain.verify": "GET /audit/control-plane/verify",
    "chain.export": "GET /audit/control-plane/export",
    "events.read": "GET /audit/events/:eventId",
  },
  storage: {
    "usage.read": "GET /storage/admin/usage",
  },
  media: {
    "usage.read": "GET /media/admin/usage",
    "delivery.read": "GET /media/admin/delivery",
  },
  leaderboard: {
    "boards.list": "GET /leaderboard/admin/boards",
    "entries.list": "GET /leaderboard/admin/boards/:board/entries",
    "locks.list": "GET /leaderboard/admin/locks",
    "entries.hide": "POST /leaderboard/admin/boards/:board/entries/:userId/hide",
    "entries.unhide": "POST /leaderboard/admin/boards/:board/entries/:userId/unhide",
    "entries.correct": "POST /leaderboard/admin/boards/:board/entries/:userId/correct",
    "locks.clear": "POST /leaderboard/admin/locks/:name/clear",
  },
  multiplayer: {
    "sessions.list": "GET /multiplayer/admin/sessions",
    "sessions.read": "GET /multiplayer/admin/sessions/:id",
    "sessions.close": "POST /multiplayer/admin/sessions/:id/close",
    "results.list": "GET /multiplayer/admin/results",
    "results.void": "POST /multiplayer/admin/results/:id/void",
  },
  rating: {
    "pools.list": "GET /rating/admin/pools",
    "players.list": "GET /rating/admin/pools/:pool/players",
    "players.read": "GET /rating/admin/pools/:pool/players/:userId",
    "players.recalculate": "POST /rating/admin/pools/:pool/players/:userId/recalculate",
    "players.reset": "POST /rating/admin/pools/:pool/players/:userId/reset",
  },
  matchmaking: {
    "queue.read": "GET /matchmaking/admin/games/:game/queue",
    "rooms.list": "GET /matchmaking/admin/games/:game/rooms",
    "invites.list": "GET /matchmaking/admin/invites",
    "invites.cancel": "POST /matchmaking/admin/invites/:id/cancel",
    "queue.drop": "POST /matchmaking/admin/games/:game/queue/:userId/drop",
  },
  ledger: {
    "accounts.list": "GET /ledger/admin/accounts",
    "accounts.read": "GET /ledger/admin/accounts/:userId",
    "transactions.list": "GET /ledger/admin/accounts/:userId/:currency/transactions",
    "accounts.credit": "POST /ledger/admin/accounts/:userId/:currency/credit",
    "accounts.debit": "POST /ledger/admin/accounts/:userId/:currency/debit",
    "transactions.reverse": "POST /ledger/admin/accounts/:userId/:currency/reverse",
    "holds.release": "POST /ledger/admin/accounts/:userId/:currency/release",
  },
  vector: {
    "indexes.list": "GET /vector/indexes",
  },
  payments: {
    "catalog.read": "GET /payments/admin/catalog",
    "purchases.list": "GET /payments/admin/purchases",
    "subscriptions.list": "GET /payments/admin/subscriptions",
    "entitlements.list": "GET /payments/admin/entitlements",
    "entitlements.read": "GET /payments/admin/entitlements/:subjectType/:subjectId",
    "discounts.list": "GET /payments/admin/discounts",
    "discounts.create": "POST /payments/admin/discounts",
    "reconcile_runs.list": "GET /payments/admin/reconcile-runs",
    "reconcile_runs.start": "POST /payments/admin/reconcile-runs",
    "entitlements.grant": "POST /payments/entitlements/grant",
    "entitlements.revoke": "POST /payments/entitlements/revoke",
    "usage_runs.list": "GET /payments/admin/usage-runs",
    "webhook_events.list": "GET /payments/admin/webhook-events",
    "overrides.list": "GET /payments/admin/overrides",
    "overrides.set": "POST /payments/entitlements/overrides",
    "overrides.unrestricted": "POST /payments/entitlements/overrides/unrestricted",
    "overrides.clear": "POST /payments/entitlements/overrides/clear",
  },
  support: {
    "threads.list": "GET /support/threads",
    "threads.read": "GET /support/threads/:id",
    "threads.archive": "POST /support/threads/:id/archive",
    "threads.assign": "POST /support/threads/:id/assign",
    "threads.reply": "POST /support/threads/:id/reply",
    "threads.reclassify": "POST /support/threads/:id/reclassify",
    "threads.flags": "POST /support/threads/:id/flags",
    "replies.list": "GET /support/replies",
  },
  testers: {
    "cohorts.list": "GET /testers/cohorts",
    "testers.invite": "POST /testers/invite",
    "testers.resend": "POST /testers/resend",
    "testers.remove": "POST /testers/remove",
    "testers.nudge": "POST /testers/nudge",
  },
  organization: {
    "organizations.list": "GET /organizations/admin/organizations",
    "members.list": "GET /organizations/admin/organizations/:organizationId/members",
    "organizations.update": "PATCH /organizations/admin/organizations/:organizationId",
    "organizations.suspend": "POST /organizations/admin/organizations/:organizationId/suspend",
    "organizations.suspend.preview": "POST /organizations/admin/organizations/:organizationId/suspend/preview",
    "organizations.reinstate": "POST /organizations/admin/organizations/:organizationId/reinstate",
    "organizations.delete": "DELETE /organizations/admin/organizations/:organizationId",
    "organizations.delete.preview": "POST /organizations/admin/organizations/:organizationId/delete/preview",
    "organizations.restore": "POST /organizations/admin/organizations/:organizationId/restore",
    "members.add": "POST /organizations/admin/organizations/:organizationId/members",
    "members.update": "PATCH /organizations/admin/organizations/:organizationId/members/:membershipId",
    "members.remove": "DELETE /organizations/admin/organizations/:organizationId/members/:membershipId",
    "invitations.list": "GET /organizations/admin/organizations/:organizationId/invitations",
    "invitations.resend": "POST /organizations/admin/organizations/:organizationId/invitations/:invitationId/resend",
    "invitations.revoke": "DELETE /organizations/admin/organizations/:organizationId/invitations/:invitationId",
    "ownership.transfer": "POST /organizations/admin/organizations/:organizationId/ownership",
  },
  artifacts: {
    "repos.list": "GET /artifacts/admin/repos",
    "repos.read": "GET /artifacts/admin/repos/:name",
    "tokens.list": "GET /artifacts/admin/repos/:name/tokens",
    "tokens.revoke": "POST /artifacts/admin/repos/:name/tokens/:tokenId/revoke",
    "tokens.revoke_all": "POST /artifacts/admin/repos/:name/tokens/revoke",
  },
  consent: {
    "purposes.read": "GET /consent/control-plane/purposes",
    "subjects.read": "GET /consent/control-plane/subjects/:kind/:subjectId",
    "documents.read": "GET /consent/control-plane/documents/:hash",
    "evidence.read": "GET /consent/control-plane/evidence/:hash",
  },
};

/** The kit's composed admin surface, as each capability declares it. */
function declared(): { capability: string; method: string; path: string; operation: string | undefined }[] {
  return kitComposition().capabilities.flatMap((capability) =>
    (capability.adminRoutes ?? []).map((route) => ({
      capability: capability.name,
      method: route.method,
      path: route.path,
      operation: route.operation,
    })),
  );
}

describe("admin route operations", () => {
  test("every kit admin route declares one", () => {
    expect(declared().filter((route) => route.operation === undefined)).toEqual([]);
  });

  test("each is unique within its capability", () => {
    const seen = new Map<string, string>();
    const collisions: string[] = [];
    for (const route of declared()) {
      const key = `${route.capability} ${route.operation}`;
      const at = `${route.method} ${route.path}`;
      if (seen.has(key)) collisions.push(`${key}: ${seen.get(key)} and ${at}`);
      seen.set(key, at);
    }
    expect(collisions).toEqual([]);
  });

  test("and so is every tool name, once `.`, `:` and `/` are normalized", () => {
    const names = declared().map((route) => controlPlaneToolName(route.capability, route.operation ?? ""));
    expect(names.filter((name, index) => names.indexOf(name) !== index)).toEqual([]);
  });

  test("none has changed since it was published", () => {
    const actual: Record<string, Record<string, string>> = {};
    for (const route of declared()) {
      const table = actual[route.capability] ?? {};
      table[route.operation ?? ""] = `${route.method} ${route.path}`;
      actual[route.capability] = table;
    }
    expect(actual).toEqual(PUBLISHED);
  });
});

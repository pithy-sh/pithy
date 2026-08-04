// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: FSL-1.1-MIT

import { EXAMPLE_ADA, EXAMPLE_ALAN, EXAMPLE_GRACE } from "@pithy-sh/core/src/seed/exampleIdentities";
import { d1SeedGroup, defineSeed, type SeedSet } from "@pithy-sh/core/src/seed/seed";
import { AuditEventRow } from "../data/auditEvent";

/**
 * Where the audit example set sorts in the project's seed registry. It runs after `auth` (100), whose
 * example seeds the users these events are attributed to, so every `actorId`/`resourceId` here points
 * at a user that already exists.
 */
const AUDIT_EXAMPLE_SEED_ORDER = 150;

/**
 * A short, realistic timeline ending "now", so the seeded events land across a dashboard's recency and
 * time-range views instead of all sharing one timestamp.
 */
const minutesAgo = (minutes: number): Date => new Date(Date.now() - minutes * 60_000);

/**
 * The origin every example row carries — so a dev database looks like a real one, and the origin
 * filters have something to return.
 *
 * `project` and `worker` are fixture constants in this file's own `example-` idiom: fictional, obviously
 * so, and stable. **`environment` is null, and that asymmetry is deliberate.** A seed row is a static
 * literal, but this set runs in both `dev` and `staging` (`environments` below) and nothing rewrites a
 * row per run — so any environment written here would be a lie in half the runs it appears in. The other
 * two are properties of the fiction; the environment is a property of the run, and the fixture does not
 * know it. Null is what "not recorded" looks like everywhere else in this column, which is also the
 * state of every row written before the origin migration.
 */
const EXAMPLE_ORIGIN = { project: "example-app", environment: null, worker: "api", version: null } as const;

/**
 * A handful of example audit events — the durable, queryable trail the licensed dashboard reads. They
 * are attributed to the shared cast from `@pithy-sh/core` ({@link EXAMPLE_ADA} et al.), so the audit
 * trail lines up with the same users `auth` seeds and `leaderboard`/`ledger`/`multiplayer` reference:
 * a fresh backend with `seed.includeExamples` on has a dashboard with something to show.
 *
 * The set is deliberately spread across the taxonomy the dashboard filters on — every `outcome`
 * (`success`/`failure`/`denied`), a range of `severity` (`info`→`critical`), and both `user` and
 * `system` actors — and across the domains that matter to a licensed product (`auth`, `entitlement`,
 * `admin`, `ledger`): a successful sign-in, a denied one, an entitlement grant, an admin config change,
 * a critical token-reuse alert, and a balance debit. Composed only when the project turns on
 * `seed.includeExamples`, and only for `dev`/`staging` — an example fixture never targets production.
 */
export const auditExampleSeed: SeedSet = defineSeed({
  name: "example",
  order: AUDIT_EXAMPLE_SEED_ORDER,
  environments: ["dev", "staging"],
  example: true,
  d1: [
    d1SeedGroup("app", "pithyAuditEvents", AuditEventRow, [
      {
        id: 1,
        eventId: "example-audit-0001",
        occurredAt: minutesAgo(90),
        action: "auth/login",
        outcome: "success",
        severity: "info",
        actorType: "user",
        actorId: EXAMPLE_ADA.id,
        sessionId: "example-session-ada",
        resourceType: null,
        resourceId: null,
        ip: "203.0.113.10",
        userAgent: "PithyDemo/1.0 (dev seed)",
        requestId: "example-req-0001",
        metadata: { method: "magic_link" },
        ...EXAMPLE_ORIGIN,
      },
      {
        id: 2,
        eventId: "example-audit-0002",
        occurredAt: minutesAgo(75),
        action: "auth/login",
        outcome: "denied",
        severity: "warning",
        actorType: "user",
        actorId: EXAMPLE_GRACE.id,
        sessionId: null,
        resourceType: null,
        resourceId: null,
        ip: "203.0.113.22",
        userAgent: "PithyDemo/1.0 (dev seed)",
        requestId: "example-req-0002",
        metadata: { reason: "expired_link" },
        ...EXAMPLE_ORIGIN,
      },
      {
        id: 3,
        eventId: "example-audit-0003",
        occurredAt: minutesAgo(60),
        action: "entitlement/granted",
        outcome: "success",
        severity: "info",
        actorType: "system",
        actorId: null,
        sessionId: null,
        resourceType: "user",
        resourceId: EXAMPLE_ALAN.id,
        ip: null,
        userAgent: null,
        requestId: "example-req-0003",
        metadata: { plan: "pro", grantedBy: "system" },
        ...EXAMPLE_ORIGIN,
      },
      {
        id: 4,
        eventId: "example-audit-0004",
        occurredAt: minutesAgo(40),
        action: "admin/config_changed",
        outcome: "success",
        severity: "warning",
        actorType: "user",
        actorId: EXAMPLE_ADA.id,
        sessionId: "example-session-ada",
        resourceType: "config",
        resourceId: "billing",
        ip: "203.0.113.10",
        userAgent: "PithyDemo/1.0 (dev seed)",
        requestId: "example-req-0004",
        metadata: { field: "seatLimit", from: 5, to: 10 },
        ...EXAMPLE_ORIGIN,
      },
      {
        id: 5,
        eventId: "example-audit-0005",
        occurredAt: minutesAgo(20),
        action: "auth/token_reuse_detected",
        outcome: "denied",
        severity: "critical",
        actorType: "user",
        actorId: EXAMPLE_GRACE.id,
        sessionId: null,
        resourceType: "session",
        resourceId: "example-family-grace",
        ip: "198.51.100.7",
        userAgent: "curl/8.4.0",
        requestId: "example-req-0005",
        metadata: { familyId: "example-family-grace", action: "family_revoked" },
        ...EXAMPLE_ORIGIN,
      },
      {
        id: 6,
        eventId: "example-audit-0006",
        occurredAt: minutesAgo(5),
        action: "ledger/debit",
        outcome: "success",
        severity: "info",
        actorType: "user",
        actorId: EXAMPLE_ALAN.id,
        sessionId: "example-session-alan",
        resourceType: "ledger",
        resourceId: "coins",
        ip: "203.0.113.31",
        userAgent: "PithyDemo/1.0 (dev seed)",
        requestId: "example-req-0006",
        metadata: { amount: 50, currency: "coins" },
        ...EXAMPLE_ORIGIN,
      },
    ]),
  ],
});

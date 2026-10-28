// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import type { D1Database } from "@cloudflare/workers-types";
import { artifacts } from "@pithy-sh/artifacts/src/capability";
import { audit } from "@pithy-sh/audit/src/capability";
import { auth } from "@pithy-sh/auth/src/capability";
import { consent } from "@pithy-sh/consent/src/capability";
import type { Capability } from "@pithy-sh/core/src/capability/capability";
import { personColumnsOf, personRowGaps } from "@pithy-sh/core/src/capability/personColumns";
import { isRetained, purgeExports, purgeSteps } from "@pithy-sh/core/src/capability/purge";
import { controlplane } from "@pithy-sh/core/src/controlPlane/capability";
import { buildRegistryFromCapabilities } from "@pithy-sh/core/src/migrations/capabilitySets";
import { runMigrations } from "@pithy-sh/core/src/migrations/runner";
import { email } from "@pithy-sh/email/src/capability";
import { i18n } from "@pithy-sh/i18n/src/capability";
import { leaderboard } from "@pithy-sh/leaderboard/src/capability";
import { ledger } from "@pithy-sh/ledger/src/capability";
import { matchmaking } from "@pithy-sh/matchmaking/src/capability";
import { media } from "@pithy-sh/media/src/capability";
import { multiplayer } from "@pithy-sh/multiplayer/src/capability";
import { organization } from "@pithy-sh/organization/src/capability";
import { defineRoles } from "@pithy-sh/organization/src/roles/roles";
import { payments } from "@pithy-sh/payments/src/capability";
import { rating } from "@pithy-sh/rating/src/capability";
import { secrets } from "@pithy-sh/secrets/src/capability";
import { storage } from "@pithy-sh/storage/src/capability";
import { support } from "@pithy-sh/support/src/capability";
import { testers } from "@pithy-sh/testers/src/capability";
import { turnstile } from "@pithy-sh/turnstile/src/capability";
import { vector } from "@pithy-sh/vector/src/capability";
import { convertV4MiniflareOptions, Miniflare } from "miniflare";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { KIT_ROOT } from "../test-utils/kitRoot";

/**
 * **Every kit capability that holds rows about a person answers for them (#814)** — it erases them on a purge, or
 * keeps them and says why, and in both cases it exports them.
 *
 * Stated over the kit rather than over a list. Every package that ships a capability manifest is constructed here,
 * its schema walked by `personRowGaps`, and a table with a person column in a capability that declares no `user`
 * contribution, or one without an export, fails the build. A capability added next year meets the gate the day it
 * ships, which is the point: the gap this closes was six capabilities wide before anybody looked.
 *
 * Then the same capabilities composed, over real D1 migrated by their own sets: the export a control plane reads
 * lists every one of them, each answered, and every erasing step runs.
 */

/** `packages/` — `KIT_ROOT` is `packages/cli`. */
const PACKAGES = join(KIT_ROOT, "..");

/** Whether a path exists. */
function exists(path: string): boolean {
  try {
    statSync(path);
    return true;
  } catch {
    return false;
  }
}

/** Every package directory that ships a capability manifest. */
const MANIFEST_PACKAGES = readdirSync(PACKAGES)
  .filter((dir) => exists(join(PACKAGES, dir, "pithy.manifest.json")))
  .sort();

const roles = defineRoles({
  roles: {
    owner: ["organization:read", "organization:manage", "members:manage", "billing:manage", "organization:delete"],
  },
  administrativePower: "organization:manage",
});

/** Every kit capability, by the package it ships in, constructed with the least config it accepts. */
const KIT: Record<string, () => Capability> = {
  artifacts: () => artifacts(),
  audit: () => audit(),
  auth: () => auth({ baseURL: "http://localhost:8787" }),
  consent: () => consent(),
  core: () => controlplane(),
  email: () => email({ fromAddress: "noreply@acme.test", baseUrl: "https://api.acme.test" }),
  i18n: () => i18n(),
  leaderboard: () => leaderboard({ boards: [{ key: "weekly", direction: "desc" }] }),
  ledger: () => ledger({ currencies: [{ code: "coins", name: "Coins" }] }),
  matchmaking: () => matchmaking({ games: [{ key: "duel", snapshot: { kind: "connect-n", rules: {} } }] }),
  media: () => media(),
  multiplayer: () =>
    multiplayer({ games: [{ key: "duel", kind: "connect-n", rules: { rows: 3, cols: 3, connect: 3 } }] }),
  organization: () => organization({ roles, baseUrl: "https://app.acme.test", sendInvitationEmail: false }),
  payments: () => payments({ billingSubject: "user" }),
  rating: () => rating({ games: [{ key: "ranked", algorithm: "elo" }] }),
  secrets: () => secrets({ registry: {} }),
  storage: () => storage(),
  support: () => support(),
  testers: () => testers(),
  turnstile: () => turnstile(),
  vector: () => vector(),
};

const capabilities = Object.values(KIT).map((build) => build());

describe("every kit capability that holds rows about a person answers for them", () => {
  test("the sweep constructs every package in the kit that ships a capability", () => {
    // The guard the gate needs: a package missing here is one this file never checks, and no gaps is what passing
    // looks like. A new capability package adds itself to KIT, or this fails.
    expect(MANIFEST_PACKAGES.length).toBeGreaterThan(15);
    expect(Object.keys(KIT).sort()).toEqual(MANIFEST_PACKAGES);
  });

  test("and finds person columns, so it is looking at schemas and not at nothing", () => {
    const holding = capabilities.filter((capability) => personColumnsOf(capability).length > 0).map((c) => c.name);
    expect(holding).toEqual(
      expect.arrayContaining(["auth", "ledger", "payments", "email", "audit", "support", "testers", "artifacts"]),
    );
  });

  test("none holds a person's rows without a user contribution that exports them", () => {
    const gaps = personRowGaps(capabilities);
    expect(gaps, JSON.stringify(gaps, null, 2)).toEqual([]);
  });

  test("the ones that keep them are the four the law or the record needs, and each says why", () => {
    const kept = capabilities.flatMap((capability) =>
      (capability.purge ?? [])
        .filter((contribution) => contribution.subject === "user" && isRetained(contribution))
        .map((contribution) => [capability.name, contribution.retain?.basis.length ?? 0] as const),
    );
    expect(kept.map(([name]) => name).sort()).toEqual(["audit", "consent", "controlplane", "email", "payments"]);
    for (const [, basis] of kept) expect(basis).toBeGreaterThan(0);
  });
});

describe("a project composing the whole kit answers an export from every one of them", () => {
  let mf: Miniflare;
  let env: Record<string, unknown>;
  const holding = capabilities.filter((capability) => personColumnsOf(capability).length > 0).map((c) => c.name);

  beforeAll(async () => {
    // One D1 per binding any composed database names, migrated by every capability's own set, as `pithy migrate` does.
    const bindings = new Map<string, string>();
    for (const capability of capabilities) {
      for (const [database, spec] of Object.entries(capability.databases ?? {})) bindings.set(database, spec.binding);
    }
    const d1Databases = Object.fromEntries([...new Set(bindings.values())].map((binding) => [binding, binding]));
    mf = new Miniflare(
      convertV4MiniflareOptions({
        modules: true,
        script: "export default {};",
        d1Databases,
        r2Buckets: ["STORAGE_BUCKET", "SUPPORT_BUCKET"],
      }),
    );
    env = {};
    for (const binding of Object.keys(d1Databases)) env[binding] = await mf.getD1Database(binding);
    env.STORAGE_BUCKET = await mf.getR2Bucket("STORAGE_BUCKET");
    env.SUPPORT_BUCKET = await mf.getR2Bucket("SUPPORT_BUCKET");
    // Matchmaking's queues are Durable Objects, whose class only its own Worker registers; its suite runs the real
    // one. Here a namespace that holds nothing stands in, so the composed export and erase reach every game's queue.
    env.QUEUE = {
      idFromName: (name: string) => name,
      get: () => ({ heldFor: async () => ({ waiting: null, match: null, drops: [] }), forget: async () => undefined }),
    };
    for (const [database, provider] of Object.entries(buildRegistryFromCapabilities(capabilities))) {
      const binding = bindings.get(database);
      if (!binding) throw new Error(`no binding for database ${database}`);
      await runMigrations(env[binding] as D1Database, provider);
    }
  }, 120_000);

  afterAll(async () => {
    await mf?.dispose();
  });

  const context = () => ({
    subject: { type: "user" as const, id: "ada" },
    env,
    address: async () => "ada@example.test",
  });

  test("the export lists every composed capability that holds rows about the person, each one answered", async () => {
    const entries = await purgeExports(purgeSteps(capabilities, "user"), context());
    expect(entries.map((entry) => entry.capability).sort()).toEqual([...holding].sort());
    expect(entries.filter((entry) => entry.state !== "exported")).toEqual([]);
    const kept = entries.filter((entry) => entry.disposition === "retain").map((entry) => entry.capability);
    expect(kept.sort()).toEqual(["audit", "consent", "controlplane", "email", "payments"]);
  });

  test("and every step that erases runs against the composed tables", async () => {
    for (const { step, contribution } of purgeSteps(capabilities, "user")) {
      if (isRetained(contribution)) continue;
      await expect(contribution.erase(context()), step).resolves.toBeUndefined();
    }
  });
});

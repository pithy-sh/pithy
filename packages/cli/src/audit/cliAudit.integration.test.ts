// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AUDIT_MIGRATION_ORDER } from "@pithy-sh/audit/src/capability";
import { resolveActor } from "@pithy-sh/audit/src/cli/resolveActor";
import { audit_0001_init } from "@pithy-sh/audit/src/migrations/0001_init";
import { audit_0002_tenant } from "@pithy-sh/audit/src/migrations/0002_tenant";
import { CloudflareClients } from "@pithy-sh/cloudflare/src/client/clients";
import { loadIntegrationCreds, uniqueName, withThrowawayResource } from "@pithy-sh/cloudflare/src/test-utils/harness";
import { accountResource } from "@pithy-sh/cloudflare/src/tokens/accountTokensManager";
import { defineCapability } from "@pithy-sh/core/src/capability/capability";
import { createMigrationRegistry } from "@pithy-sh/core/src/migrations/registry";
import { runMigrations } from "@pithy-sh/core/src/migrations/runner";
import type { MigrationProvider } from "kysely/migration";
import { describe, expect, test } from "vitest";
import { createCliAudit } from "./cliAudit";

/**
 * LIVE test that a CLI audit event is attributed to the **account-owned token that performed it**.
 *
 * It mints a real least-privilege `cfat_*` token, creates a throwaway D1, runs audit's migration over
 * REST, drives `createCliAudit` with that token as both the client credential and the `apiToken`, and
 * reads the persisted row back through an independent credential to assert its actor columns.
 *
 * **Fakes cannot catch this class of bug.** Actor resolution failure is never fatal, and so is the
 * audit write — so a resolver pointed at the wrong Cloudflare scope answers `Invalid API Token`,
 * degrades to `system`, and every gate stays green. That is exactly what shipped: the account path
 * verified against `GET /user/tokens/verify`, which no `cfat_*` token can call. Only a real token
 * against real endpoints, with the row read back, proves the attribution landed.
 *
 * The token is minted rather than borrowed from `.dev.vars` so the expected `actorId` is deterministic
 * — and so the test runs under exactly the least-privilege shape CI does, which cannot read its own
 * token name and must therefore fall back to the token id. Gated on CF creds in `.dev.vars`; skips
 * clean without them. The bootstrap token must carry "Account API Tokens Write".
 */
const creds = loadIntegrationCreds();

/** Audit's migrations, composed the way `pithy migrate` composes them for the app database. */
function auditMigrations(): MigrationProvider {
  const registry = createMigrationRegistry([
    {
      database: "app",
      namespace: "audit",
      order: AUDIT_MIGRATION_ORDER,
      migrations: { "0001_init": audit_0001_init, "0002_tenant": audit_0002_tenant },
    },
  ]);
  const provider = registry.app;
  if (!provider) throw new Error("no app migration provider");
  return provider;
}

/** A minimal project on disk: one Worker whose `staging` stanza binds `DB` to the throwaway database. */
async function writeProject(databaseId: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "pithy-cliaudit-live-"));
  const worker = join(dir, "apps", "api");
  await mkdir(worker, { recursive: true });
  await writeFile(
    join(worker, "wrangler.jsonc"),
    JSON.stringify({ name: "api", env: { staging: { d1_databases: [{ binding: "DB", database_id: databaseId }] } } }),
  );
  return dir;
}

/**
 * Wait until a freshly minted token answers its own verify. A new token is usable within a second or
 * two, not instantly — and the failure mode is silent: actor resolution is never fatal, so a token that
 * has not propagated yet writes `system` and the assertions below read as the very regression they
 * guard. Better to wait for the credential than to report a bug that isn't there.
 */
async function awaitTokenReady(clients: CloudflareClients): Promise<void> {
  for (let attempt = 0; attempt < 10; attempt++) {
    const ready = await clients
      .accountTokens()
      .verifyToken()
      .then(
        () => true,
        () => false,
      );
    if (ready) return;
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
  throw new Error("the minted token never verified");
}

/** The row shape the assertions read back — snake_case, because this is raw SQL, not Kysely. */
interface ActorRow {
  actor_type: string;
  actor_id: string;
  environment: string;
  metadata: string;
}

describe.skipIf(!creds.hasCreds)("createCliAudit — LIVE actor attribution under an account token", () => {
  const boot = new CloudflareClients({ accountId: creds.accountId, apiToken: creds.apiToken });

  test("attributes an emitted event to the minted token, not to system", async () => {
    const tokenName = uniqueName("cliaudit-token");
    try {
      // Deliberately without "Account API Tokens Read": this is the CI shape, which cannot read its own
      // name. Permission-group display names directly rather than `resolvePermissionKeys` — this test
      // pins actor attribution, not the permission catalog.
      const minted = await boot
        .accountTokens()
        .mintToken(tokenName, [
          { permissionGroupNames: ["D1 Read", "D1 Write"], resources: accountResource(creds.accountId) },
        ]);

      // The prefix is the whole routing decision. If Cloudflare ever changes it, fail here loudly
      // rather than silently downgrade every account-token event to `system`.
      expect(minted.value.startsWith("cfat_")).toBe(true);

      // The minted token is both the credential and the identity, as it is in a real CI run.
      const scoped = new CloudflareClients({ accountId: creds.accountId, apiToken: minted.value });
      await awaitTokenReady(scoped);

      await withThrowawayResource(
        () => boot.d1Provisioner().createDatabase(uniqueName("cliaudit")),
        async (database) => {
          const remote = boot.d1(database.uuid);
          await runMigrations(remote as unknown as D1Database, auditMigrations());

          const dir = await writeProject(database.uuid);
          try {
            const emit = await createCliAudit({
              projectDir: dir,
              env: "staging",
              actedOn: "staging",
              capabilities: [defineCapability({ name: "audit", requiredBindings: [] })],
              clients: scoped,
              apiToken: minted.value,
            });
            await emit({ action: "token/minted", outcome: "success", metadata: { test: tokenName } });
          } finally {
            await rm(dir, { recursive: true, force: true });
          }

          // Read back through the bootstrap credential — an independent token, so the read cannot
          // inherit whatever the write got wrong.
          const rows = await remote
            .prepare("select actor_type, actor_id, environment, metadata from pithy_audit_events")
            .all<ActorRow>();

          // The emit is non-fatal at two levels, so a missing row is the real failure mode.
          expect(rows.results).toHaveLength(1);
          const row = rows.results[0] as ActorRow;
          expect(row.actor_type).toBe("service");
          expect(row.actor_type).not.toBe("system");
          expect(row.actor_id).toBe(minted.id);
          expect(row.environment).toBe("staging");

          const metadata = JSON.parse(row.metadata) as Record<string, unknown>;
          expect(metadata.cfTokenType).toBe("account");
          expect(metadata.cfTokenId).toBe(minted.id);
          expect(metadata.cfTokenStatus).toBe("active");
          // `systemActor`'s marker. Its absence is the precise proof nothing silently fell back.
          expect(metadata.actorResolutionFailed).toBeUndefined();
        },
        (database) => boot.d1Provisioner().deleteDatabase(database.uuid),
      );
    } finally {
      await boot.accountTokens().deleteTokensByName(tokenName);
    }
  }, 120_000);

  test("resolves the token name when the token may read its own record, and never via /user", async () => {
    const tokenName = uniqueName("cliaudit-named");
    try {
      const minted = await boot
        .accountTokens()
        .mintToken(tokenName, [
          { permissionGroupNames: ["Account API Tokens Read"], resources: accountResource(creds.accountId) },
        ]);
      const scoped = new CloudflareClients({ accountId: creds.accountId, apiToken: minted.value });
      await awaitTokenReady(scoped);

      // The seam literal is the one `cliAudit` builds — same shape, same managers.
      const actor = await resolveActor(minted.value, { user: scoped.user(), accountTokens: scoped.accountTokens() });
      expect(actor.actorType).toBe("service");
      expect(actor.actorId).toBe(tokenName);

      // The mechanism, named: a `cfat_*` token is rejected at every `/user/*` endpoint. Routing the
      // account path through the user manager threw here, and — resolution being never fatal — landed
      // every account-token event on `system`.
      await expect(scoped.user().getUser()).rejects.toThrow();
    } finally {
      await boot.accountTokens().deleteTokensByName(tokenName);
    }
  }, 60_000);
});

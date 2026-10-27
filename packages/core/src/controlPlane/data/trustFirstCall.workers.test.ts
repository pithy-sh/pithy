// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { env } from "cloudflare:test";
import type { Kysely } from "kysely";
import { beforeEach, describe, expect, test } from "vitest";
import { createDatabase } from "../../data/db";
import { controlplane_0001_init } from "../migrations/0001_init";
import { controlplane_0002_management_origin } from "../migrations/0002_management_origin";
import { controlplane_0003_connection_principal } from "../migrations/0003_connection_principal";
import { controlplane_0004_connection_trusts } from "../migrations/0004_connection_trusts";
import { ControlPlaneConnection } from "./connection";
import type { OidcTrust } from "./oidcTrust";
import { CONTROL_PLANE_CONNECTIONS_TABLE, controlPlaneDatabase } from "./tables";
import { recordTrustFirstCall } from "./trustFirstCall";

const db = () => createDatabase(env.DB, {}) as unknown as Kysely<unknown>;
const ID = "3f2504e0-4f89-41d3-9a0c-0305e82c3301";
const AT = new Date("2026-10-27T12:00:00.000Z");

function trust(trustId: string, overrides: Partial<OidcTrust> = {}): OidcTrust {
  return {
    trustId,
    issuer: "https://token.actions.githubusercontent.com",
    jwksUrl: "https://token.actions.githubusercontent.com/.well-known/jwks",
    audience: "https://api.example.com",
    claims: { repository_id: "1262274726" },
    authorizedBy: "ada@example.com",
    validFrom: new Date("2026-10-01T00:00:00.000Z"),
    revokedAt: null,
    firstCallAt: null,
    ...overrides,
  };
}

async function seed(trusts: OidcTrust[]): Promise<void> {
  await controlPlaneDatabase(env.DB)
    .insertInto(CONTROL_PLANE_CONNECTIONS_TABLE)
    .values(
      ControlPlaneConnection.encode({
        id: ID,
        environment: "prod",
        issuer: "https://token.actions.githubusercontent.com",
        workerUrl: "https://api.example.com",
        basePath: "/control-plane",
        managementOrigin: null,
        authorizedBy: "ada@example.com",
        actorKind: "agent",
        purpose: "Nightly audit summarizer.",
        scopes: ["manifest:read"],
        keys: [],
        trusts,
        createdAt: AT,
        updatedAt: AT,
      }),
    )
    .execute();
}

async function trusts(): Promise<OidcTrust[]> {
  const row = await controlPlaneDatabase(env.DB)
    .selectFrom(CONTROL_PLANE_CONNECTIONS_TABLE)
    .selectAll()
    .where("id", "=", ID)
    .executeTakeFirstOrThrow();
  return ControlPlaneConnection.parse(row).trusts ?? [];
}

beforeEach(async () => {
  await env.DB.exec("DROP TABLE IF EXISTS pithy_controlplane_connections");
  await env.DB.exec("DROP TABLE IF EXISTS pithy_controlplane_replays");
  await controlplane_0001_init.up(db());
  await controlplane_0002_management_origin.up(db());
  await controlplane_0003_connection_principal.up(db());
  await controlplane_0004_connection_trusts.up(db());
});

describe("recordTrustFirstCall", () => {
  test("stamps the named trust's first call and touches nothing else", async () => {
    await seed([trust("a"), trust("b")]);
    await recordTrustFirstCall(controlPlaneDatabase(env.DB), ID, "b", AT);
    const after = await trusts();
    expect(after.map((t) => t.firstCallAt)).toEqual([null, AT]);
    expect(after[1]).toEqual({ ...trust("b"), firstCallAt: AT });
  });

  test("never moves a first call already recorded", async () => {
    const earlier = new Date("2026-10-20T00:00:00.000Z");
    await seed([trust("a", { firstCallAt: earlier })]);
    await recordTrustFirstCall(controlPlaneDatabase(env.DB), ID, "a", AT);
    expect((await trusts())[0]?.firstCallAt).toEqual(earlier);
  });

  test("leaves a revoked trust exactly as revoked — a stale read cannot resurrect it", async () => {
    await seed([trust("a", { revokedAt: AT })]);
    await recordTrustFirstCall(controlPlaneDatabase(env.DB), ID, "a", AT);
    expect(await trusts()).toEqual([trust("a", { revokedAt: AT })]);
  });

  test("does nothing for a trust the connection does not hold", async () => {
    await seed([trust("a")]);
    await recordTrustFirstCall(controlPlaneDatabase(env.DB), ID, "zzz", AT);
    expect(await trusts()).toEqual([trust("a")]);
  });
});

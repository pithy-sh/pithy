// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { env } from "cloudflare:test";
import type { AuditEventInput } from "@pithy-sh/core/src/audit/auditEvent";
import type { PithyHonoEnv } from "@pithy-sh/core/src/capability/capability";
import { ControlPlaneConfig } from "@pithy-sh/core/src/controlPlane/config/config";
import type { ControlPlaneConnection } from "@pithy-sh/core/src/controlPlane/data/connection";
import { type ControlPlaneVerifier, createControlPlaneVerifier } from "@pithy-sh/core/src/controlPlane/http/guard";
import type { ControlPlaneScope } from "@pithy-sh/core/src/controlPlane/scope/scope";
import { exportPublicJwk, mintControlPlaneToken } from "@pithy-sh/core/src/controlPlane/token/mint";
import { CONTROL_PLANE_HEADER } from "@pithy-sh/core/src/controlPlane/wire";
import { createDatabase } from "@pithy-sh/core/src/data/db";
import { pithyErrorHandler } from "@pithy-sh/core/src/error/http";
import { noopLogger } from "@pithy-sh/core/src/logger/logger";
import { Hono } from "hono";
import type { Kysely } from "kysely";
import { beforeAll, beforeEach, describe, expect, test } from "vitest";
import type { z } from "zod";
import type {
  ArtifactsCommitMetadataShape,
  ArtifactsNamespaceBinding,
  ArtifactsRepoHandle,
  ArtifactsTokenMetadata,
} from "../binding/artifacts";
import { parseArtifactsConfig } from "../config/config";
import { TOKEN_RECORD_RETENTION_MS } from "../data/records";
import { artifactsStore } from "../data/store";
import { artifactsDatabase } from "../data/tables";
import { artifacts_0001_init } from "../migrations/0001_init";
import { artifacts_0002_tokens } from "../migrations/0002_tokens";
import { AdminRepoDetail, AdminRepoList, AdminRevocation, AdminTokenList } from "./responses";
import { registerArtifactsRoutes } from "./routes";
import { ARTIFACTS_REPOS_READ_SCOPE, ARTIFACTS_TOKENS_REVOKE_SCOPE } from "./scopes";

/**
 * The control-plane surface, actually executed: a live verifier over a signed token, a real D1, and a stand-in
 * Artifacts binding. `routeContract.test.ts` proves the guards refuse; this proves what the handlers do once let in —
 * the paging, the holder join, the outside-Pithy label, and an idempotent revoke that emits once.
 */

const NOW = new Date();
const CONNECTION_ID = "6f1d2e40-7b3a-4c9e-8d51-2a4b6c8e0f13";
const ISSUER = "https://dashboard.example";
const KEY_ID = "key-1";
const ENVIRONMENT = "prod";
const BOTH: readonly ControlPlaneScope[] = [ARTIFACTS_REPOS_READ_SCOPE, ARTIFACTS_TOKENS_REVOKE_SCOPE];

const commit = (n: number): ArtifactsCommitMetadataShape => ({
  hash: n.toString(16).padStart(40, "0"),
  treeHash: "b".repeat(40),
  message: `commit ${n}`,
  author: { name: "Alice", email: "alice@example.com" },
  committer: { name: "Alice", email: "alice@example.com" },
  parents: [],
  authoredAt: n,
  committedAt: n,
});
const HISTORY = [5, 4, 3, 2, 1].map(commit);

type FakeToken = ArtifactsTokenMetadata;
interface FakeRepo {
  tokens: Map<string, FakeToken>;
  infoFails?: boolean;
}

/**
 * The namespace, in memory. `listTokens` answers every token in every state, oldest first, one page of at most `page`
 * with no cursor. The real binding lists active tokens only; this one keeps revoked ones on its page, the listing that
 * would end a list-and-revoke loop at the first page, so revoking by record is held against the worse case.
 */
function fakeNamespace(page = Number.POSITIVE_INFINITY) {
  const repos = new Map<string, FakeRepo>();
  let sequence = 0;
  const handle = (name: string, repo: FakeRepo): ArtifactsRepoHandle => ({
    createToken: async (scope = "write", ttl = 900) => {
      sequence += 1;
      const token: FakeToken = {
        id: `tok_${sequence}`,
        scope,
        state: "active",
        createdAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + ttl * 1000).toISOString(),
      };
      repo.tokens.set(token.id, token);
      return { id: token.id, plaintext: `art_v1_${"0".repeat(40)}`, scope, expiresAt: token.expiresAt };
    },
    listTokens: async () => ({
      tokens: [...repo.tokens.values()].slice(0, page).map((t) => ({ ...t })),
      total: repo.tokens.size,
    }),
    revokeToken: async (id) => {
      const token = repo.tokens.get(id);
      if (token?.state !== "active") return false;
      token.state = "revoked";
      return true;
    },
    info: async () => {
      if (repo.infoFails) throw Object.assign(new Error("ArtifactsError: INTERNAL"), { name: "ArtifactsError" });
      return {
        id: `id-${name}`,
        name,
        description: "Docs.",
        defaultBranch: "main",
        createdAt: "2026-10-18T00:00:00.000Z",
        updatedAt: "2026-10-18T00:00:00.000Z",
        lastPushAt: "2026-10-20T00:00:00.000Z",
        source: null,
        readOnly: false,
        remote: `https://acct.artifacts.cloudflare.net/git/acme-prod/${name}.git`,
      };
    },
    readBlob: async () => null,
    readTree: async () => null,
    readCommit: async () => null,
    readFile: async () => null,
    log: async (opts) => HISTORY.slice(opts?.offset ?? 0, (opts?.offset ?? 0) + (opts?.limit ?? 50)),
  });
  const binding: ArtifactsNamespaceBinding = {
    create: async () => {
      throw new Error("the control plane never creates a repository");
    },
    get: async (name) => {
      const repo = repos.get(name);
      if (!repo)
        throw Object.assign(new Error("ArtifactsError: NOT_FOUND"), { name: "ArtifactsError", code: "NOT_FOUND" });
      return handle(name, repo);
    },
    delete: async (name) => repos.delete(name),
  };
  return { binding, repos, handle: (name: string) => binding.get(name) };
}

let keys: CryptoKeyPair;
let emitted: AuditEventInput[];
let namespace: ReturnType<typeof fakeNamespace>;
const store = () => artifactsStore(artifactsDatabase(env.DB));

beforeAll(async () => {
  keys = (await crypto.subtle.generateKey("Ed25519", false, ["sign", "verify"])) as CryptoKeyPair;
});

async function connection(scopes: readonly ControlPlaneScope[]): Promise<ControlPlaneConnection> {
  return {
    id: CONNECTION_ID,
    environment: ENVIRONMENT,
    issuer: ISSUER,
    workerUrl: "https://acme.example",
    basePath: "/control-plane",
    managementOrigin: null,
    authorizedBy: "ada@example.com",
    actorKind: "dashboard",
    purpose: "The hosted dashboard.",
    scopes: [...scopes],
    keys: [
      {
        keyId: KEY_ID,
        publicKey: await exportPublicJwk(keys.publicKey),
        validFrom: new Date(NOW.getTime() - 86_400_000),
        validUntil: null,
        revokedAt: null,
      },
    ],
    createdAt: new Date(NOW.getTime() - 86_400_000),
    updatedAt: new Date(NOW.getTime() - 86_400_000),
  };
}

function verifier(scopes: readonly ControlPlaneScope[]): ControlPlaneVerifier {
  const registered = connection(scopes);
  const spent = new Set<string>();
  return createControlPlaneVerifier({
    loadConnection: async (id) => {
      const row = await registered;
      return id === row.id ? row : null;
    },
    countConnections: async () => 1,
    replay: {
      async claim(jti) {
        if (spent.has(jti)) return false;
        spent.add(jti);
        return true;
      },
    },
    environment: ENVIRONMENT,
    config: ControlPlaneConfig.parse({}),
    now: () => new Date(),
  });
}

/** The app, with a live control-plane verifier granted `scopes`, and a capturing audit seam. */
function makeApp(scopes: readonly ControlPlaneScope[] = BOTH) {
  const app = new Hono<PithyHonoEnv>();
  app.onError(pithyErrorHandler);
  const cpVerifier = verifier(scopes);
  app.use("*", async (c, next) => {
    c.set("auth", null);
    c.set("controlPlane", null);
    c.set("controlPlaneVerifier", cpVerifier);
    c.set("emit", async (event: AuditEventInput) => void emitted.push(event));
    c.set("log", noopLogger);
    await next();
  });
  registerArtifactsRoutes({ config: parseArtifactsConfig({}), organization: () => false })(app);
  return app;
}

/** One call carrying a freshly minted control-plane token for `scope`, and the body it is bound to. */
async function call(
  app: Hono<PithyHonoEnv>,
  path: string,
  scope: ControlPlaneScope,
  body?: unknown,
): Promise<Response> {
  const payload = body === undefined ? undefined : JSON.stringify(body);
  const token = await mintControlPlaneToken({
    privateKey: keys.privateKey,
    keyId: KEY_ID,
    issuer: ISSUER,
    connectionId: CONNECTION_ID,
    subject: "operator-1",
    scope,
    body: payload === undefined ? undefined : new TextEncoder().encode(payload),
    now: () => new Date(),
  });
  return app.request(
    `http://x${path}`,
    {
      method: payload === undefined ? "GET" : "POST",
      headers: { "content-type": "application/json", [CONTROL_PLANE_HEADER]: token },
      body: payload,
    },
    { ...env, ENVIRONMENT, ARTIFACTS: namespace.binding },
  );
}

const revoke = (app: Hono<PithyHonoEnv>, path: string, body: unknown) =>
  call(app, path, ARTIFACTS_TOKENS_REVOKE_SCOPE, body);

/** Read a response through its schema, and require the parse to hand back exactly what arrived. */
async function conforming<Schema extends z.ZodType>(res: Response, schema: Schema): Promise<z.infer<Schema>> {
  expect(res.status).toBe(200);
  const body: unknown = await res.json();
  expect(schema.parse(body)).toEqual(body);
  return body as z.infer<Schema>;
}

/** The events this capability emitted. The guard records every verified call too; those are core's, not ours. */
const acts = () => emitted.filter((event) => event.action.startsWith("artifacts/"));

const errorCode = async (res: Response) => ((await res.json()) as { error: { code: string } }).error.code;

/** A repository the kit knows: its row, and its namespace entry. */
async function seedRepo(
  name: string,
  overrides: {
    ownerKind?: "org" | "user";
    ownerId?: string;
    createdAt?: Date;
    infoFails?: boolean;
    remoteAccess?: boolean;
  } = {},
) {
  const at = overrides.createdAt ?? NOW;
  await store().insertRepo({
    name,
    displayName: `display-${name}`,
    ownerKind: overrides.ownerKind ?? "user",
    ownerId: overrides.ownerId ?? "alice",
    remoteAccess: overrides.remoteAccess ?? true,
    createdAt: at,
    updatedAt: at,
  });
  namespace.repos.set(name, {
    tokens: new Map(),
    ...(overrides.infoFails ? { infoFails: true } : {}),
  });
}

/** Mint a token on the binding, and record it against `userId` the way the credential route does. */
async function mintFor(repo: string, userId: string | null, scope: "read" | "write" = "write") {
  const minted = await (await namespace.handle(repo)).createToken(scope, 900);
  if (userId !== null) {
    await store().recordTokens([
      {
        id: minted.id,
        repo,
        userId,
        scope,
        source: "credential",
        createdAt: new Date(),
        expiresAt: new Date(minted.expiresAt),
      },
    ]);
  }
  return minted.id;
}

beforeEach(async () => {
  for (const table of ["revocations", "tokens", "grants", "repos"]) {
    await env.DB.exec(`DROP TABLE IF EXISTS pithy_artifacts_${table}`);
  }
  const db = createDatabase(env.DB, {}) as unknown as Kysely<unknown>;
  await artifacts_0001_init.up(db);
  await artifacts_0002_tokens.up(db);
  namespace = fakeNamespace();
  emitted = [];
});

describe("GET /artifacts/admin/repos", () => {
  test("lists every owner's repositories newest first, paged, with the last push Cloudflare holds", async () => {
    await seedRepo("r-old", { createdAt: new Date(NOW.getTime() - 2000) });
    await seedRepo("r-org", { ownerKind: "org", ownerId: "acme", createdAt: new Date(NOW.getTime() - 1000) });
    await seedRepo("r-new");
    const app = makeApp();

    const first = await conforming(
      await call(app, "/artifacts/admin/repos?limit=2", ARTIFACTS_REPOS_READ_SCOPE),
      AdminRepoList,
    );
    expect(first.repos.map((repo) => repo.name)).toEqual(["r-new", "r-org"]);
    expect(first.repos[1]).toEqual({
      name: "r-org",
      displayName: "display-r-org",
      owner: { kind: "org", id: "acme" },
      remoteAccess: true,
      createdAt: new Date(NOW.getTime() - 1000).toISOString(),
      updatedAt: new Date(NOW.getTime() - 1000).toISOString(),
      lastPushAt: "2026-10-20T00:00:00.000Z",
    });
    expect(first.nextCursor).not.toBeNull();

    const second = await conforming(
      await call(app, `/artifacts/admin/repos?limit=2&cursor=${first.nextCursor ?? ""}`, ARTIFACTS_REPOS_READ_SCOPE),
      AdminRepoList,
    );
    expect(second.repos.map((repo) => repo.name)).toEqual(["r-old"]);
    expect(second.nextCursor).toBeNull();
  });

  test("a repository Cloudflare cannot answer for costs its last push, not the page", async () => {
    await seedRepo("fine");
    await seedRepo("broken", { createdAt: new Date(NOW.getTime() - 1000), infoFails: true });
    const listed = await conforming(
      await call(makeApp(), "/artifacts/admin/repos", ARTIFACTS_REPOS_READ_SCOPE),
      AdminRepoList,
    );
    expect(listed.repos.map((repo) => [repo.name, repo.lastPushAt])).toEqual([
      ["fine", "2026-10-20T00:00:00.000Z"],
      ["broken", undefined],
    ]);
  });
});

describe("GET /artifacts/admin/repos/:name", () => {
  test("answers the metadata, every grant, and the commit log from log(), paged", async () => {
    await seedRepo("r1");
    await store().setGrant("r1", "carol", "write", NOW);
    await store().setGrant("r1", "bob", "read", NOW);
    const app = makeApp();

    const first = await conforming(
      await call(app, "/artifacts/admin/repos/r1?limit=2", ARTIFACTS_REPOS_READ_SCOPE),
      AdminRepoDetail,
    );
    expect(first.repo).toMatchObject({
      name: "r1",
      owner: { kind: "user", id: "alice" },
      description: "Docs.",
      defaultBranch: "main",
      lastPushAt: "2026-10-20T00:00:00.000Z",
      readOnly: false,
      remote: "https://acct.artifacts.cloudflare.net/git/acme-prod/r1.git",
    });
    expect(first.grants.map((grant) => [grant.userId, grant.grant])).toEqual([
      ["bob", "read"],
      ["carol", "write"],
    ]);
    expect(first.commits.map((entry) => entry.message)).toEqual(["commit 5", "commit 4"]);
    expect(first.nextOffset).toBe(2);

    const last = await conforming(
      await call(app, "/artifacts/admin/repos/r1?limit=2&offset=4", ARTIFACTS_REPOS_READ_SCOPE),
      AdminRepoDetail,
    );
    expect(last.commits.map((entry) => entry.message)).toEqual(["commit 1"]);
    expect(last.nextOffset).toBeNull();
  });

  test("never answers the clone URL of a repository whose remote access is off", async () => {
    await seedRepo("r1", { remoteAccess: false });
    const res = await call(makeApp(), "/artifacts/admin/repos/r1", ARTIFACTS_REPOS_READ_SCOPE);
    const detail = await conforming(res, AdminRepoDetail);
    expect(detail.repo.remoteAccess).toBe(false);
    expect(detail.repo).not.toHaveProperty("remote");
    expect(JSON.stringify(detail)).not.toContain(".git");
  });

  test("a repository the kit does not know is a 404", async () => {
    const res = await call(makeApp(), "/artifacts/admin/repos/nope", ARTIFACTS_REPOS_READ_SCOPE);
    expect(res.status).toBe(404);
    expect(await errorCode(res)).toBe("artifacts/not_found");
  });
});

describe("GET /artifacts/admin/repos/:name/tokens", () => {
  test("lists every token the binding holds, naming the holder where the kit recorded one", async () => {
    await seedRepo("r1");
    const bobs = await mintFor("r1", "bob", "read");
    const outside = await mintFor("r1", null);
    const listed = await conforming(
      await call(makeApp(), "/artifacts/admin/repos/r1/tokens", ARTIFACTS_REPOS_READ_SCOPE),
      AdminTokenList,
    );
    expect(listed.total).toBe(2);
    expect(listed.tokens).toEqual([
      expect.objectContaining({ id: bobs, scope: "read", state: "active", minted: "pithy", holderId: "bob" }),
      // Minted outside Pithy — Cloudflare's dashboard, a script — and never given a holder.
      expect.objectContaining({ id: outside, minted: "outside", holderId: null, source: null }),
    ]);
    expect(JSON.stringify(listed)).not.toMatch(/art_v1_/);
  });

  test("an unrecorded token expired longer ago than records are kept is unknown, not outside", async () => {
    await seedRepo("r1");
    namespace.repos.get("r1")?.tokens.set("tok_ancient", {
      id: "tok_ancient",
      scope: "write",
      state: "expired",
      createdAt: new Date(NOW.getTime() - TOKEN_RECORD_RETENTION_MS - 7_200_000).toISOString(),
      expiresAt: new Date(NOW.getTime() - TOKEN_RECORD_RETENTION_MS - 3_600_000).toISOString(),
    });
    const listed = await conforming(
      await call(makeApp(), "/artifacts/admin/repos/r1/tokens", ARTIFACTS_REPOS_READ_SCOPE),
      AdminTokenList,
    );
    expect(listed.tokens).toEqual([expect.objectContaining({ id: "tok_ancient", minted: "unknown", holderId: null })]);
  });

  test("an unrecorded token created before the kit began recording is unknown, not outside", async () => {
    // Minted by the kit before 0002_tokens ran: the create token every existing repository revoked, say.
    await seedRepo("r1");
    namespace.repos.get("r1")?.tokens.set("tok_before", {
      id: "tok_before",
      scope: "write",
      state: "revoked",
      createdAt: new Date(NOW.getTime() - 86_400_000).toISOString(),
      expiresAt: new Date(NOW.getTime() + 3_600_000).toISOString(),
    });
    const listed = await conforming(
      await call(makeApp(), "/artifacts/admin/repos/r1/tokens", ARTIFACTS_REPOS_READ_SCOPE),
      AdminTokenList,
    );
    expect(listed.tokens).toEqual([expect.objectContaining({ id: "tok_before", minted: "unknown", holderId: null })]);
  });
});

describe("revoking one token", () => {
  test("revokes it, emits one control-plane audit event with the reason, and a replay changes nothing", async () => {
    await seedRepo("r1", { ownerKind: "org", ownerId: "acme" });
    const id = await mintFor("r1", "bob");
    const app = makeApp();
    const body = { idempotencyKey: "rev-1", reason: "Bob left the company." };

    const first = await conforming(
      await revoke(app, `/artifacts/admin/repos/r1/tokens/${id}/revoke`, body),
      AdminRevocation,
    );
    expect(first).toMatchObject({ repo: "r1", tokenId: id, revoked: 1, reason: body.reason, replayed: false });
    expect(namespace.repos.get("r1")?.tokens.get(id)?.state).toBe("revoked");
    expect(acts()).toEqual([
      expect.objectContaining({
        action: "artifacts/token_revoked",
        actorType: "control-plane",
        actorId: "operator-1",
        resourceType: "artifacts_repo",
        resourceId: "r1",
        tenant: "acme",
        metadata: expect.objectContaining({
          connectionId: CONNECTION_ID,
          reason: body.reason,
          tokenId: id,
          holderId: "bob",
          revoked: 1,
        }),
      }),
    ]);

    const again = await conforming(
      await revoke(app, `/artifacts/admin/repos/r1/tokens/${id}/revoke`, body),
      AdminRevocation,
    );
    expect(again).toEqual({ ...first, replayed: true });
    expect(acts()).toHaveLength(1);
  });

  test("refuses a missing reason or key before anything is revoked", async () => {
    await seedRepo("r1");
    const id = await mintFor("r1", "bob");
    const app = makeApp();
    for (const body of [{ idempotencyKey: "k" }, { idempotencyKey: "k", reason: "   " }, { reason: "Why." }]) {
      const res = await revoke(app, `/artifacts/admin/repos/r1/tokens/${id}/revoke`, body);
      expect(res.status, JSON.stringify(body)).toBe(400);
    }
    expect(namespace.repos.get("r1")?.tokens.get(id)?.state).toBe("active");
    expect(acts()).toEqual([]);
  });

  test("a token the repository does not hold is a 404, and spends no key", async () => {
    await seedRepo("r1");
    const app = makeApp();
    const body = { idempotencyKey: "rev-1", reason: "Typo." };
    const res = await revoke(app, "/artifacts/admin/repos/r1/tokens/tok_nope/revoke", body);
    expect(res.status).toBe(404);
    expect(acts()).toEqual([]);
    const id = await mintFor("r1", "bob");
    const retried = await revoke(app, `/artifacts/admin/repos/r1/tokens/${id}/revoke`, body);
    expect((await conforming(retried, AdminRevocation)).revoked).toBe(1);
  });

  test("a key spent on one revocation is refused for another", async () => {
    await seedRepo("r1");
    const first = await mintFor("r1", "bob");
    const second = await mintFor("r1", "bob");
    const app = makeApp();
    const body = { idempotencyKey: "rev-1", reason: "Rotate." };
    await conforming(await revoke(app, `/artifacts/admin/repos/r1/tokens/${first}/revoke`, body), AdminRevocation);
    const res = await revoke(app, `/artifacts/admin/repos/r1/tokens/${second}/revoke`, body);
    expect(res.status).toBe(409);
    expect(namespace.repos.get("r1")?.tokens.get(second)?.state).toBe("active");
    expect(acts()).toHaveLength(1);
  });
});

describe("revoking every live token", () => {
  test("revokes every live token, emits one event, and a replay revokes nothing minted since", async () => {
    await seedRepo("r1");
    await mintFor("r1", "bob");
    await mintFor("r1", null);
    const app = makeApp();
    const body = { idempotencyKey: "all-1", reason: "Suspected leak." };

    const first = await conforming(await revoke(app, "/artifacts/admin/repos/r1/tokens/revoke", body), AdminRevocation);
    expect(first).toMatchObject({ repo: "r1", tokenId: null, revoked: 2, replayed: false });
    expect(acts()).toEqual([
      expect.objectContaining({
        action: "artifacts/tokens_revoked",
        actorType: "control-plane",
        severity: "warning",
        metadata: expect.objectContaining({ reason: body.reason, revoked: 2, idempotencyKey: "all-1" }),
      }),
    ]);

    const fresh = await mintFor("r1", "carol");
    const again = await conforming(await revoke(app, "/artifacts/admin/repos/r1/tokens/revoke", body), AdminRevocation);
    expect(again).toEqual({ ...first, replayed: true });
    expect(namespace.repos.get("r1")?.tokens.get(fresh)?.state).toBe("active");
    expect(acts()).toHaveLength(1);
  });

  test("reaches every token the kit minted when the listing keeps revoked ones on its one page", async () => {
    namespace = fakeNamespace(2);
    await seedRepo("r1");
    const minted = [];
    for (let i = 0; i < 5; i += 1) minted.push(await mintFor("r1", "bob"));
    const body = { idempotencyKey: "all-paged", reason: "Suspected leak." };

    const view = await conforming(
      await revoke(makeApp(), "/artifacts/admin/repos/r1/tokens/revoke", body),
      AdminRevocation,
    );
    expect(view.revoked).toBe(5);
    const live = minted.filter((id) => namespace.repos.get("r1")?.tokens.get(id)?.state === "active");
    expect(live).toEqual([]);
  });

  test("of two concurrent requests under one key, exactly one records and emits; the other replays it", async () => {
    await seedRepo("r1");
    await mintFor("r1", "bob");
    const app = makeApp();
    const body = { idempotencyKey: "all-race", reason: "Suspected leak." };

    const [a, b] = await Promise.all([
      revoke(app, "/artifacts/admin/repos/r1/tokens/revoke", body),
      revoke(app, "/artifacts/admin/repos/r1/tokens/revoke", body),
    ]);
    const answers = [await conforming(a, AdminRevocation), await conforming(b, AdminRevocation)];
    const won = answers.find((x) => !x.replayed);
    const lost = answers.find((x) => x.replayed);
    expect(won).toBeDefined();
    expect(lost).toBeDefined();
    expect(lost).toEqual({ ...won, replayed: true });
    expect(acts()).toHaveLength(1);
  });

  test("never answers the clone URL of a repository whose remote access is off", async () => {
    await seedRepo("r1", { remoteAccess: false });
    const res = await call(makeApp(), "/artifacts/admin/repos/r1", ARTIFACTS_REPOS_READ_SCOPE);
    const detail = await conforming(res, AdminRepoDetail);
    expect(detail.repo.remoteAccess).toBe(false);
    expect(detail.repo).not.toHaveProperty("remote");
    expect(JSON.stringify(detail)).not.toContain(".git");
  });

  test("a repository the kit does not know is a 404", async () => {
    const res = await revoke(makeApp(), "/artifacts/admin/repos/nope/tokens/revoke", {
      idempotencyKey: "k",
      reason: "Why.",
    });
    expect(res.status).toBe(404);
    expect(acts()).toEqual([]);
  });
});

describe("the scopes", () => {
  test("reading needs artifacts:repos:read, and revoking needs artifacts:tokens:revoke", async () => {
    await seedRepo("r1");
    const id = await mintFor("r1", "bob");
    const readOnly = makeApp([ARTIFACTS_REPOS_READ_SCOPE]);
    const revokeOnly = makeApp([ARTIFACTS_TOKENS_REVOKE_SCOPE]);
    for (const path of ["/artifacts/admin/repos", "/artifacts/admin/repos/r1", "/artifacts/admin/repos/r1/tokens"]) {
      expect((await call(revokeOnly, path, ARTIFACTS_REPOS_READ_SCOPE)).status, path).toBe(403);
    }
    const body = { idempotencyKey: "k", reason: "Why." };
    expect((await revoke(readOnly, `/artifacts/admin/repos/r1/tokens/${id}/revoke`, body)).status).toBe(403);
    expect((await revoke(readOnly, "/artifacts/admin/repos/r1/tokens/revoke", body)).status).toBe(403);
    expect(namespace.repos.get("r1")?.tokens.get(id)?.state).toBe("active");
  });
});

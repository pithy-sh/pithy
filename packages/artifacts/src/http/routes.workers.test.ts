// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { env } from "cloudflare:test";
import type { ActingOrganization } from "@pithy-sh/core/src/access/acting";
import type { AuditEventInput } from "@pithy-sh/core/src/audit/auditEvent";
import { type Capability, defineCapability } from "@pithy-sh/core/src/capability/capability";
import { createBackend } from "@pithy-sh/core/src/createBackend";
import { createDatabase } from "@pithy-sh/core/src/data/db";
import { PithyError } from "@pithy-sh/core/src/error/pithyError";
import type { Kysely } from "kysely";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { z } from "zod";
import type {
  ArtifactsCommitMetadataShape,
  ArtifactsNamespaceBinding,
  ArtifactsRepoHandle,
  ArtifactsTokenMetadata,
} from "../binding/artifacts";
import { type ArtifactsOptions, artifacts } from "../capability";
import { artifacts_0001_init } from "../migrations/0001_init";
import { REPO_NAME_CHARSET } from "../naming/repoName";
import {
  GrantView,
  LogView,
  RepoCredential,
  RepoDetail,
  RepoList,
  RepoView,
  RevokedTokens,
  TreeView,
} from "./responses";

/**
 * The repository routes, composed whole through `createBackend` over a real D1 and a stand-in Artifacts binding.
 * Miniflare has no Artifacts simulation, so the namespace is a map that answers the way Cloudflare's binding
 * documents: `ArtifactsError` codes, a token returned at create, a plaintext token per mint, a token list per repo.
 */

const COMMIT: ArtifactsCommitMetadataShape = {
  hash: "a".repeat(40),
  treeHash: "b".repeat(40),
  message: "first",
  author: { name: "Alice", email: "alice@example.com" },
  committer: { name: "Alice", email: "alice@example.com" },
  parents: [],
  authoredAt: 1,
  committedAt: 1,
};

interface FakeRepo {
  description: string | null;
  tokens: Map<string, ArtifactsTokenMetadata & { plaintext: string }>;
}

/** An `ArtifactsError`, as the binding throws one. */
function artifactsError(code: string): Error {
  return Object.assign(new Error(`ArtifactsError: ${code}`), { name: "ArtifactsError", code, numericCode: 1 });
}

/** The account's namespace, in memory, answering the way Cloudflare's binding documents. */
function fakeNamespace() {
  const repos = new Map<string, FakeRepo>();
  let sequence = 0;
  const mint = (repo: FakeRepo, scope: "read" | "write", ttl: number) => {
    sequence += 1;
    const expires = Math.floor(Date.now() / 1000) + ttl;
    const token = {
      id: `tok_${sequence}`,
      plaintext: `art_v1_${sequence.toString(16).padStart(40, "0")}?expires=${expires}`,
      scope,
      state: "active" as const,
      createdAt: new Date().toISOString(),
      expiresAt: new Date(expires * 1000).toISOString(),
    };
    repo.tokens.set(token.id, token);
    return token;
  };
  const handle = (name: string, repo: FakeRepo): ArtifactsRepoHandle => ({
    createToken: async (scope = "write", ttl = 86400) => {
      const { id, plaintext, scope: granted, expiresAt } = mint(repo, scope, ttl);
      return { id, plaintext, scope: granted, expiresAt };
    },
    listTokens: async () => {
      const tokens = [...repo.tokens.values()].map(({ plaintext: _hidden, ...metadata }) => metadata);
      return { tokens, total: tokens.length };
    },
    revokeToken: async (tokenOrId) => {
      for (const token of repo.tokens.values()) {
        if ((token.id === tokenOrId || token.plaintext === tokenOrId) && token.state === "active") {
          token.state = "revoked";
          return true;
        }
      }
      return false;
    },
    info: async () => ({
      id: `id-${name}`,
      name,
      description: repo.description,
      defaultBranch: "main",
      createdAt: "2026-10-18T00:00:00.000Z",
      updatedAt: "2026-10-18T00:00:00.000Z",
      lastPushAt: null,
      source: null,
      readOnly: false,
      remote: `https://acct.artifacts.cloudflare.net/git/acme-dev/${name}.git`,
    }),
    readBlob: async (hash) => (hash === COMMIT.hash ? new Blob(["<script>alert(1)</script>"]) : null),
    readTree: async (hash) =>
      hash === COMMIT.treeHash ? [{ name: "README.md", mode: "100644", hash: COMMIT.hash, type: "blob" }] : null,
    readCommit: async (hash) => (hash === COMMIT.hash ? COMMIT : null),
    readFile: async ({ path }) => (path === "index.html" ? new Blob(["<h1>hi</h1>"], { type: "text/html" }) : null),
    log: async () => [COMMIT],
  });
  const binding: ArtifactsNamespaceBinding = {
    create: async (name, opts) => {
      if (repos.has(name)) throw artifactsError("ALREADY_EXISTS");
      if (!REPO_NAME_CHARSET.test(name)) throw artifactsError("INVALID_REPO_NAME");
      const repo: FakeRepo = { description: opts?.description ?? null, tokens: new Map() };
      repos.set(name, repo);
      const initial = mint(repo, "write", 86400);
      return { name, remote: "x", token: initial.plaintext, defaultBranch: "main" };
    },
    get: async (name) => {
      const repo = repos.get(name);
      if (!repo) throw artifactsError("NOT_FOUND");
      return handle(name, repo);
    },
    delete: async (name) => repos.delete(name),
  };
  return { binding, repos };
}

/** Who a request acts for in an organization, by header: `x-org` and `x-powers`. */
function actingFrom(headers: Headers): ActingOrganization | null {
  const organizationId = headers.get("x-org");
  if (!organizationId) return null;
  const powers = (headers.get("x-powers") ?? "").split(",").filter(Boolean);
  return { organizationId, roleAllows: (power) => powers.includes(power) };
}

/** A stand-in for `@pithy-sh/auth`, `@pithy-sh/audit` and the identity half of `@pithy-sh/organization`. */
function seams(events: AuditEventInput[]): Capability {
  return defineCapability({
    name: "identity",
    requiredBindings: [],
    middleware: [
      (app) =>
        app.use("*", async (c, next) => {
          const user = c.req.header("x-user");
          c.set("auth", user ? { userId: user, sessionId: `s-${user}`, scopes: [] } : null);
          c.set("emit", async (event: AuditEventInput) => void events.push(event));
          const acting = actingFrom(c.req.raw.headers);
          c.set("actingOrganization", async () => acting);
          await next();
        }),
    ],
  });
}

/** A stand-in for `@pithy-sh/organization`, recognized by name and carrying a catalog's powers by shape. */
function tenancy(powers: string[]): Capability {
  return Object.assign(defineCapability({ name: "organization", requiredBindings: [] }), {
    organizationRoles: { powers },
  });
}

let namespace: ReturnType<typeof fakeNamespace>;
let events: AuditEventInput[];
let output: string[];

function worker(options: ArtifactsOptions = {}, extra: Capability[] = []) {
  return createBackend({ capabilities: [seams(events), ...extra, artifacts(options)] });
}

type Backend = ReturnType<typeof worker>;

function call(
  app: Backend,
  path: string,
  user: string | null,
  init: RequestInit & { org?: string; powers?: string } = {},
) {
  const { org, powers, ...rest } = init;
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (user) headers["x-user"] = user;
  if (org) headers["x-org"] = org;
  if (powers) headers["x-powers"] = powers;
  return app.request(
    path,
    { ...rest, headers: { ...headers, ...(rest.headers as Record<string, string>) } },
    {
      ...env,
      ARTIFACTS: namespace.binding,
    },
  );
}

/** Read a response through its schema, and require the parse to hand back exactly what arrived. */
async function conforming<Schema extends z.ZodType>(res: Response, schema: Schema): Promise<z.infer<Schema>> {
  const body: unknown = await res.json();
  expect(schema.parse(body)).toEqual(body);
  return body as z.infer<Schema>;
}

async function createRepo(app: Backend, user: string, displayName: string, extra: Record<string, unknown> = {}) {
  const res = await call(app, "/artifacts/repos", user, {
    method: "POST",
    body: JSON.stringify({ displayName, ...extra }),
  });
  expect(res.status).toBe(201);
  return conforming(res, RepoView);
}

beforeEach(async () => {
  await env.DB.exec("DROP TABLE IF EXISTS pithy_artifacts_grants");
  await env.DB.exec("DROP TABLE IF EXISTS pithy_artifacts_repos");
  await artifacts_0001_init.up(createDatabase(env.DB, {}) as unknown as Kysely<unknown>);
  namespace = fakeNamespace();
  events = [];
  output = [];
  for (const method of ["log", "info", "warn", "error", "debug"] as const) {
    vi.spyOn(console, method).mockImplementation((...args: unknown[]) => {
      output.push(args.map((arg) => (typeof arg === "string" ? arg : JSON.stringify(arg))).join(" "));
    });
  }
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("creating a repository", () => {
  test("names it with a UUID inside Cloudflare's charset and cap, and makes the caller its owner", async () => {
    const app = worker();
    const repo = await createRepo(app, "alice", "docs");
    expect(repo.name).toMatch(/^[0-9a-f-]{36}$/);
    expect(repo.name).toMatch(REPO_NAME_CHARSET);
    expect(repo).toMatchObject({ displayName: "docs", owner: { kind: "user", id: "alice" }, access: "owner" });
    expect(namespace.repos.has(repo.name)).toBe(true);
  });

  test("revokes the token Cloudflare creates the repository with, so no long-lived credential exists", async () => {
    const app = worker();
    const repo = await createRepo(app, "alice", "docs");
    const tokens = [...(namespace.repos.get(repo.name)?.tokens.values() ?? [])];
    expect(tokens).toHaveLength(1);
    expect(tokens[0]?.state).toBe("revoked");
  });

  for (const [failure, revoke] of [
    ["throws", async () => Promise.reject(artifactsError("INTERNAL"))],
    ["answers false", async () => false],
  ] as const) {
    test(`deletes the repository again when revoking its create token ${failure}`, async () => {
      const app = worker();
      const get = namespace.binding.get;
      namespace.binding.get = async (name) => ({ ...(await get(name)), revokeToken: revoke });
      const res = await call(app, "/artifacts/repos", "alice", {
        method: "POST",
        body: JSON.stringify({ displayName: "docs" }),
      });
      expect(res.status).toBe(502);
      expect(((await res.json()) as { error: { code: string } }).error.code).toBe("core/upstream_failed");
      expect(namespace.repos.size).toBe(0);
      namespace.binding.get = get;
      const listed = await conforming(await call(app, "/artifacts/repos", "alice"), RepoList);
      expect(listed.repos).toHaveLength(0);
      expect(output.join("\n")).not.toMatch(/art_v1_/);
    });
  }

  test("refuses a supplied name unless the Worker takes one, and then refuses one that breaks the rule", async () => {
    const closed = await call(worker(), "/artifacts/repos", "alice", {
      method: "POST",
      body: JSON.stringify({ displayName: "docs", name: "docs" }),
    });
    expect(closed.status).toBe(400);
    expect(((await closed.json()) as { error: { code: string } }).error.code).toBe("artifacts/invalid_name");

    const open = worker({ acceptRepoName: true });
    for (const [name, rule] of [
      ["has.slash/", /letter or digit/],
      ["x", /2 to 63 characters/],
      ["y".repeat(64), /2 to 63 characters/],
    ] as const) {
      const res = await call(open, "/artifacts/repos", "alice", {
        method: "POST",
        body: JSON.stringify({ displayName: `d-${name.length}-${name[0]}`, name }),
      });
      expect(res.status, name).toBe(400);
      const { error } = (await res.json()) as { error: { code: string; message: string } };
      expect(error.code).toBe("artifacts/invalid_name");
      expect(error.message).toMatch(rule);
    }
    expect(namespace.repos.size).toBe(0);
    const named = await createRepo(open, "alice", "docs", { name: "alice-docs" });
    expect(named.name).toBe("alice-docs");
  });

  test("a supplied name already in the namespace is a refusal the adopter caused", async () => {
    const app = worker({ acceptRepoName: true });
    await createRepo(app, "alice", "docs", { name: "shared" });
    const res = await call(app, "/artifacts/repos", "bob", {
      method: "POST",
      body: JSON.stringify({ displayName: "docs", name: "shared" }),
    });
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe("artifacts/name_taken");
  });

  test("takes the adopter's naming seam, held to the same rule", async () => {
    const app = worker({ repoName: ({ owner, displayName }) => `${owner.id}-${displayName}` });
    expect((await createRepo(app, "alice", "docs")).name).toBe("alice-docs");
    const bad = await call(worker({ repoName: () => "no/slashes" }), "/artifacts/repos", "alice", {
      method: "POST",
      body: JSON.stringify({ displayName: "docs" }),
    });
    expect(bad.status).toBe(400);
  });

  test("two owners may both hold `docs`, and neither's physical name appears in the other's listing", async () => {
    const app = worker();
    const alice = await createRepo(app, "alice", "docs");
    const bob = await createRepo(app, "bob", "docs");
    const again = await call(app, "/artifacts/repos", "alice", {
      method: "POST",
      body: JSON.stringify({ displayName: "docs" }),
    });
    expect(again.status).toBe(409);
    const aliceList = await conforming(await call(app, "/artifacts/repos", "alice"), RepoList);
    const bobList = await conforming(await call(app, "/artifacts/repos", "bob"), RepoList);
    expect(aliceList.repos.map((repo) => repo.name)).toEqual([alice.name]);
    expect(bobList.repos.map((repo) => repo.name)).toEqual([bob.name]);
    expect(JSON.stringify(aliceList)).not.toContain(bob.name);
    expect(JSON.stringify(bobList)).not.toContain(alice.name);
  });

  test("is refused without a signed-in caller", async () => {
    const res = await call(worker(), "/artifacts/repos", null, {
      method: "POST",
      body: JSON.stringify({ displayName: "x" }),
    });
    expect(res.status).toBe(401);
  });
});

describe("who may see a repository", () => {
  test("a caller with no grant and no ownership gets the 404 a missing repository gets, byte for byte", async () => {
    const app = worker();
    const repo = await createRepo(app, "alice", "docs");
    for (const suffix of ["", "/log", "/credentials", `/tree/${COMMIT.treeHash}`]) {
      const method = suffix === "/credentials" ? "POST" : "GET";
      const stranger = await call(app, `/artifacts/repos/${repo.name}${suffix}`, "mallory", { method });
      const missing = await call(app, `/artifacts/repos/00000000-0000-4000-8000-000000000000${suffix}`, "mallory", {
        method,
      });
      expect(stranger.status, suffix).toBe(404);
      expect(missing.status, suffix).toBe(404);
      expect(stranger.headers.get("content-type")).toBe(missing.headers.get("content-type"));
      const [a, b] = [await stranger.text(), await missing.text()];
      expect(a).toBe(b);
      expect(a).not.toContain(repo.name);
    }
  });

  test("a grant opens the repository; a grant value the catalog does not know opens nothing", async () => {
    const app = worker();
    const repo = await createRepo(app, "alice", "docs");
    await env.DB.prepare(
      "INSERT INTO pithy_artifacts_grants (repo, user_id, \"grant\", created_at, updated_at) VALUES (?, 'mallory', 'admin', 0, 0)",
    )
      .bind(repo.name)
      .run();
    const refused = await call(app, `/artifacts/repos/${repo.name}`, "mallory");
    const missing = await call(app, "/artifacts/repos/00000000-0000-4000-8000-000000000000", "mallory");
    expect(refused.status).toBe(404);
    expect(await refused.text()).toBe(await missing.text());

    await call(app, `/artifacts/repos/${repo.name}/grants`, "alice", {
      method: "POST",
      body: JSON.stringify({ userId: "bob", grant: "read" }),
    });
    const detail = await conforming(await call(app, `/artifacts/repos/${repo.name}`, "bob"), RepoDetail);
    expect(detail.access).toBe("read");
    expect(detail.remote).toContain(repo.name);
    const listed = await conforming(await call(app, "/artifacts/repos", "bob"), RepoList);
    expect(listed.repos.map((entry) => [entry.name, entry.access])).toEqual([[repo.name, "read"]]);
  });

  test("only the owner manages grants; a grant holder is told no, a stranger is told nothing", async () => {
    const app = worker();
    const repo = await createRepo(app, "alice", "docs");
    const set = await call(app, `/artifacts/repos/${repo.name}/grants`, "alice", {
      method: "POST",
      body: JSON.stringify({ userId: "bob", grant: "write" }),
    });
    expect(set.status).toBe(200);
    expect(await conforming(set, GrantView)).toMatchObject({ repo: repo.name, userId: "bob", grant: "write" });
    const byHolder = await call(app, `/artifacts/repos/${repo.name}/grants`, "bob", {
      method: "POST",
      body: JSON.stringify({ userId: "carol", grant: "write" }),
    });
    expect(byHolder.status).toBe(403);
    const byStranger = await call(app, `/artifacts/repos/${repo.name}/grants/bob`, "carol", { method: "DELETE" });
    expect(byStranger.status).toBe(404);
    expect((await call(app, `/artifacts/repos/${repo.name}/grants/bob`, "alice", { method: "DELETE" })).status).toBe(
      204,
    );
    expect((await call(app, `/artifacts/repos/${repo.name}`, "bob")).status).toBe(404);
  });
});

describe("minting a token", () => {
  test("mints at tokenTtlSeconds with the caller's grant as the scope, and returns expiresAt and the remote", async () => {
    const app = worker({ tokenTtlSeconds: 600 });
    const repo = await createRepo(app, "alice", "docs");
    const before = Date.now();
    const res = await call(app, `/artifacts/repos/${repo.name}/credentials`, "alice", { method: "POST" });
    expect(res.status).toBe(201);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const credential = await conforming(res, RepoCredential);
    expect(credential.scope).toBe("write");
    expect(credential.token).toMatch(/^art_v1_[0-9a-f]{40}\?expires=\d+$/);
    expect(credential.remote).toBe(`https://acct.artifacts.cloudflare.net/git/acme-dev/${repo.name}.git`);
    const lives = Date.parse(credential.expiresAt) - before;
    expect(lives).toBeGreaterThan(590_000);
    expect(lives).toBeLessThanOrEqual(601_000);
  });

  test("a read grant gets a read token, and can never obtain a write one", async () => {
    const app = worker();
    const repo = await createRepo(app, "alice", "docs");
    await call(app, `/artifacts/repos/${repo.name}/grants`, "alice", {
      method: "POST",
      body: JSON.stringify({ userId: "bob", grant: "read" }),
    });
    for (const body of [undefined, JSON.stringify({ scope: "write" })]) {
      const res = await call(app, `/artifacts/repos/${repo.name}/credentials`, "bob", { method: "POST", body });
      expect((await conforming(res, RepoCredential)).scope).toBe("read");
    }
    const live = [...(namespace.repos.get(repo.name)?.tokens.values() ?? [])].filter((t) => t.state === "active");
    expect(live.map((token) => token.scope)).toEqual(["read", "read"]);
  });

  test("a write grant gets a write token", async () => {
    const app = worker();
    const repo = await createRepo(app, "alice", "docs");
    await call(app, `/artifacts/repos/${repo.name}/grants`, "alice", {
      method: "POST",
      body: JSON.stringify({ userId: "bob", grant: "write" }),
    });
    const res = await call(app, `/artifacts/repos/${repo.name}/credentials`, "bob", { method: "POST" });
    expect((await conforming(res, RepoCredential)).scope).toBe("write");
  });
});

describe("remote access off", () => {
  test("the mint route answers the one 404, every in-Worker read still answers, and nothing discloses the remote", async () => {
    const app = worker();
    const repo = await createRepo(app, "alice", "content", { remoteAccess: false });
    expect(repo.remoteAccess).toBe(false);
    const bodies: string[] = [JSON.stringify(repo)];

    const mint = await call(app, `/artifacts/repos/${repo.name}/credentials`, "alice", { method: "POST" });
    const missing = await call(app, "/artifacts/repos/00000000-0000-4000-8000-000000000000/credentials", "alice", {
      method: "POST",
    });
    expect(mint.status).toBe(404);
    const mintBody = await mint.text();
    expect(mintBody).toBe(await missing.text());
    bodies.push(mintBody);

    const detail = await call(app, `/artifacts/repos/${repo.name}`, "alice");
    expect(detail.status).toBe(200);
    const parsed = await conforming(detail, RepoDetail);
    expect("remote" in parsed).toBe(false);
    bodies.push(JSON.stringify(parsed));

    const log = await call(app, `/artifacts/repos/${repo.name}/log?limit=5`, "alice");
    expect(log.status).toBe(200);
    bodies.push(JSON.stringify(await conforming(log, LogView)));
    const commit = await call(app, `/artifacts/repos/${repo.name}/commits/${COMMIT.hash}`, "alice");
    expect(commit.status).toBe(200);
    bodies.push(await commit.text());
    const tree = await call(app, `/artifacts/repos/${repo.name}/tree/${COMMIT.treeHash}`, "alice");
    expect(tree.status).toBe(200);
    bodies.push(JSON.stringify(await conforming(tree, TreeView)));
    const blob = await call(app, `/artifacts/repos/${repo.name}/blob/${COMMIT.hash}`, "alice");
    expect(blob.status).toBe(200);
    bodies.push(await blob.text());
    const file = await call(app, `/artifacts/repos/${repo.name}/file?ref=main&path=index.html`, "alice");
    expect(file.status).toBe(200);
    bodies.push(await file.text());
    bodies.push(JSON.stringify(await (await call(app, "/artifacts/repos", "alice")).json()));

    for (const body of bodies) expect(body).not.toContain("artifacts.cloudflare.net");
  });
});

describe("the in-Worker reads", () => {
  test("serve a repository's bytes inert: never sniffed, sandboxed, and saved rather than opened", async () => {
    const app = worker();
    const repo = await createRepo(app, "alice", "docs");
    const blob = await call(app, `/artifacts/repos/${repo.name}/blob/${COMMIT.hash}`, "alice");
    expect(blob.headers.get("content-type")).toBe("application/octet-stream");
    const file = await call(app, `/artifacts/repos/${repo.name}/file?ref=main&path=index.html`, "alice");
    expect(file.headers.get("content-type")).toBe("text/html");
    for (const res of [blob, file]) {
      expect(res.headers.get("x-content-type-options")).toBe("nosniff");
      expect(res.headers.get("content-security-policy")).toBe("default-src 'none'; sandbox");
      expect(res.headers.get("content-disposition")).toBe("attachment");
    }
  });

  test("answer a missing object with a plain 404, and refuse a malformed hash before reaching Cloudflare", async () => {
    const app = worker();
    const repo = await createRepo(app, "alice", "docs");
    expect((await call(app, `/artifacts/repos/${repo.name}/tree/${"c".repeat(40)}`, "alice")).status).toBe(404);
    expect((await call(app, `/artifacts/repos/${repo.name}/tree/not-a-hash`, "alice")).status).toBe(400);
    expect((await call(app, `/artifacts/repos/${repo.name}/file?ref=main&path=missing.md`, "alice")).status).toBe(404);
  });
});

describe("revoking every token", () => {
  test("revokes every live token on the repository, and is refused for anybody but the owner", async () => {
    const app = worker();
    const repo = await createRepo(app, "alice", "docs");
    await call(app, `/artifacts/repos/${repo.name}/grants`, "alice", {
      method: "POST",
      body: JSON.stringify({ userId: "bob", grant: "write" }),
    });
    await call(app, `/artifacts/repos/${repo.name}/credentials`, "alice", { method: "POST" });
    await call(app, `/artifacts/repos/${repo.name}/credentials`, "bob", { method: "POST" });

    expect((await call(app, `/artifacts/repos/${repo.name}/credentials`, "bob", { method: "DELETE" })).status).toBe(
      403,
    );
    expect((await call(app, `/artifacts/repos/${repo.name}/credentials`, "carol", { method: "DELETE" })).status).toBe(
      404,
    );
    const res = await call(app, `/artifacts/repos/${repo.name}/credentials`, "alice", { method: "DELETE" });
    expect(await conforming(res, RevokedTokens)).toEqual({ revoked: 2 });
    const live = [...(namespace.repos.get(repo.name)?.tokens.values() ?? [])].filter((t) => t.state === "active");
    expect(live).toEqual([]);
  });
});

describe("deleting a repository", () => {
  test("deletes it in Cloudflare and its rows, and only for the owner", async () => {
    const app = worker();
    const repo = await createRepo(app, "alice", "docs");
    await call(app, `/artifacts/repos/${repo.name}/grants`, "alice", {
      method: "POST",
      body: JSON.stringify({ userId: "bob", grant: "write" }),
    });
    expect((await call(app, `/artifacts/repos/${repo.name}`, "bob", { method: "DELETE" })).status).toBe(403);
    expect((await call(app, `/artifacts/repos/${repo.name}`, "alice", { method: "DELETE" })).status).toBe(204);
    expect(namespace.repos.has(repo.name)).toBe(false);
    expect((await call(app, `/artifacts/repos/${repo.name}`, "alice")).status).toBe(404);
    expect((await call(app, `/artifacts/repos/${repo.name}`, "bob")).status).toBe(404);
  });
});

describe("the audit trail", () => {
  test("records create, grant change, mint, revoke and delete, and never a token", async () => {
    const app = worker();
    const repo = await createRepo(app, "alice", "docs");
    await call(app, `/artifacts/repos/${repo.name}/grants`, "alice", {
      method: "POST",
      body: JSON.stringify({ userId: "bob", grant: "read" }),
    });
    await call(app, `/artifacts/repos/${repo.name}/grants/bob`, "alice", { method: "DELETE" });
    const minted = await conforming(
      await call(app, `/artifacts/repos/${repo.name}/credentials`, "alice", { method: "POST" }),
      RepoCredential,
    );
    await call(app, `/artifacts/repos/${repo.name}/credentials`, "alice", { method: "DELETE" });
    await call(app, `/artifacts/repos/${repo.name}`, "alice", { method: "DELETE" });

    expect(events.map((event) => event.action)).toEqual([
      "artifacts/repo_created",
      "artifacts/grant_set",
      "artifacts/grant_removed",
      "artifacts/token_minted",
      "artifacts/tokens_revoked",
      "artifacts/repo_deleted",
    ]);
    for (const event of events) {
      expect(event).toMatchObject({ actorId: "alice", resourceType: "artifacts_repo", resourceId: repo.name });
    }
    expect(JSON.stringify(events)).not.toContain(minted.token);
    expect(JSON.stringify(events)).not.toContain("art_v1_");
  });
});

describe("the token is in one response body and nowhere else", () => {
  test("absent from every log line and every error body", async () => {
    const app = worker();
    const repo = await createRepo(app, "alice", "docs");
    await call(app, `/artifacts/repos/${repo.name}/grants`, "alice", {
      method: "POST",
      body: JSON.stringify({ userId: "bob", grant: "read" }),
    });
    const minted = await conforming(
      await call(app, `/artifacts/repos/${repo.name}/credentials`, "alice", { method: "POST" }),
      RepoCredential,
    );
    // Every refusal this repository can produce, each with the token presented as if it were a credential.
    const errors: string[] = [];
    const as = { headers: { authorization: `Bearer ${minted.token}` } };
    for (const [path, user, method] of [
      [`/artifacts/repos/${repo.name}`, "mallory", "GET"],
      [`/artifacts/repos/${repo.name}/credentials`, "bob", "DELETE"],
      [`/artifacts/repos/${repo.name}`, "bob", "DELETE"],
      [`/artifacts/repos/${repo.name}/tree/zz`, "alice", "GET"],
      [`/artifacts/repos/${repo.name}/credentials`, null, "POST"],
    ] as const) {
      const res = await call(app, path, user, { method, ...as });
      expect(res.status).toBeGreaterThanOrEqual(400);
      errors.push(await res.text());
    }
    // And a failure inside Cloudflare, mid-mint.
    const original = namespace.binding.get;
    namespace.binding.get = async () => {
      throw artifactsError("INTERNAL_ERROR");
    };
    const upstream = await call(app, `/artifacts/repos/${repo.name}/credentials`, "alice", { method: "POST" });
    namespace.binding.get = original;
    expect(upstream.status).toBe(502);
    errors.push(await upstream.text());

    for (const body of errors) expect(body).not.toContain("art_v1_");
    expect(output.length).toBeGreaterThan(0);
    for (const line of output) expect(line).not.toContain("art_v1_");
  });
});

describe("organizations", () => {
  test("without organization composed, every repository is a person's and the organization routes do not mount", async () => {
    const app = worker({ managePower: "repos:manage" });
    const created = await createRepo(app, "alice", "docs");
    expect(created.owner.kind).toBe("user");
    for (const method of ["GET", "POST"]) {
      const res = await call(app, "/artifacts/organization/repos", "alice", {
        method,
        org: "acme",
        powers: "repos:manage",
        ...(method === "POST" ? { body: JSON.stringify({ displayName: "site" }) } : {}),
      });
      expect(res.status, method).toBe(404);
    }
  });

  test("managePower is required when organization is composed, and refused at boot", () => {
    let caught: unknown;
    try {
      worker({}, [tenancy(["repos:manage"])]);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(PithyError);
    expect((caught as PithyError).payload.code).toBe("artifacts/invalid_config");
    expect((caught as PithyError).payload.message).toMatch(/managePower/);
  });

  test("a managePower the role catalog does not declare is refused at boot, naming it", () => {
    let caught: unknown;
    try {
      worker({ managePower: "repos:manag" }, [tenancy(["repos:manage", "members:manage"])]);
    } catch (error) {
      caught = error;
    }
    expect((caught as PithyError).payload.code).toBe("artifacts/invalid_config");
    expect((caught as PithyError).payload.message).toContain("`repos:manag`");
  });

  test("a member whose role holds managePower creates and lists the organization's repositories", async () => {
    const app = worker({ managePower: "repos:manage" }, [tenancy(["repos:manage"])]);
    const res = await call(app, "/artifacts/organization/repos", "bob", {
      method: "POST",
      org: "acme",
      powers: "repos:manage",
      body: JSON.stringify({ displayName: "site" }),
    });
    expect(res.status).toBe(201);
    const repo = await conforming(res, RepoView);
    expect(repo.owner).toEqual({ kind: "org", id: "acme" });
    expect(events.at(-1)).toMatchObject({ action: "artifacts/repo_created", tenant: "acme", actorId: "bob" });

    const listed = await conforming(
      await call(app, "/artifacts/organization/repos", "carol", { org: "acme", powers: "repos:manage" }),
      RepoList,
    );
    expect(listed.repos.map((entry) => entry.name)).toEqual([repo.name]);

    // A manager is the repository's owner, so the owner-only routes answer them.
    const mint = await call(app, `/artifacts/repos/${repo.name}/credentials`, "carol", {
      method: "POST",
      org: "acme",
      powers: "repos:manage",
    });
    expect((await conforming(mint, RepoCredential)).scope).toBe("write");
  });

  test("the organization routes are requireOrganization, then requirePower, in that order", async () => {
    const app = worker({ managePower: "repos:manage" }, [tenancy(["repos:manage"])]);
    const none = await call(app, "/artifacts/organization/repos", "bob");
    expect(none.status).toBe(403);
    expect(((await none.json()) as { error: { message: string } }).error.message).toBe("No organization is in force.");
    const short = await call(app, "/artifacts/organization/repos", "bob", { org: "acme", powers: "members:manage" });
    expect(short.status).toBe(403);
    expect(((await short.json()) as { error: { message: string } }).error.message).toContain("`repos:manage`");
    expect((await call(app, "/artifacts/organization/repos", null, { org: "acme" })).status).toBe(401);
  });

  test("an organization's repository is the one 404 to a member of another organization, or one without the power", async () => {
    const app = worker({ managePower: "repos:manage" }, [tenancy(["repos:manage"])]);
    const repo = await conforming(
      await call(app, "/artifacts/organization/repos", "bob", {
        method: "POST",
        org: "acme",
        powers: "repos:manage",
        body: JSON.stringify({ displayName: "site" }),
      }),
      RepoView,
    );
    const missing = await (await call(app, "/artifacts/repos/00000000-0000-4000-8000-000000000000", "eve")).text();
    for (const [org, powers] of [
      ["other", "repos:manage"],
      ["acme", "members:manage"],
    ] as const) {
      const res = await call(app, `/artifacts/repos/${repo.name}`, "eve", { org, powers });
      expect(res.status).toBe(404);
      expect(await res.text()).toBe(missing);
    }
  });
});

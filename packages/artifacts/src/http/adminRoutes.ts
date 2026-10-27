// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import type { PithyHonoEnv } from "@pithy-sh/core/src/capability/capability";
import type { ControlPlaneContext } from "@pithy-sh/core/src/controlPlane/context";
import { requireControlPlane } from "@pithy-sh/core/src/controlPlane/http/guard";
import { DEFAULT_PAGE_SIZE } from "@pithy-sh/core/src/data/cursor";
import { ConflictError, InternalError, NotFoundError } from "@pithy-sh/core/src/error/pithyError";
import { describeRoute } from "@pithy-sh/core/src/http/routeSpec";
import { validate } from "@pithy-sh/core/src/http/validation";
import type { Context, Hono } from "hono";
import { type ArtifactsAuditAction, ArtifactsAuditActions, recordArtifactsAction } from "../audit/actions";
import { artifactsBinding, revokeEveryToken, withRepo } from "../binding/artifacts";
import type { ArtifactsConfig } from "../config/config";
import type { ArtifactsRepoRecord, ArtifactsRevocationKind, ArtifactsRevocationRecord } from "../data/records";
import type { ArtifactsStore } from "../data/store";
import { ArtifactsNotFoundError } from "../error/errors";
import { storeOf } from "./context";
import { AdminRepoDetail, AdminRepoList, AdminRevocation, AdminTokenList } from "./responses";
import { AdminRepoQuery, AdminReposQuery, AdminRevokeBody, AdminTokenParams, RepoParams } from "./schemas";
import { ARTIFACTS_REPOS_READ_SCOPE, ARTIFACTS_TOKENS_REVOKE_SCOPE } from "./scopes";
import { adminRepoDetailView, adminRepoView, adminTokenView, commitView, grantView, revocationView } from "./views";

/**
 * **The control-plane surface: what a management client may read about an app's repositories, and the keys it may
 * take back.** Every route wears core's `requireControlPlane` and nothing else — a management client is not a
 * signed-in person, holds no session, and is never asked for `requireAuth()`, which would refuse it permanently.
 *
 * | Method | Path | Scope |
 * |---|---|---|
 * | GET | `/admin/repos` | `artifacts:repos:read` |
 * | GET | `/admin/repos/:name` | `artifacts:repos:read` |
 * | GET | `/admin/repos/:name/tokens` | `artifacts:repos:read` |
 * | POST | `/admin/repos/:name/tokens/:tokenId/revoke` | `artifacts:tokens:revoke` |
 * | POST | `/admin/repos/:name/tokens/revoke` | `artifacts:tokens:revoke` |
 *
 * **A revoke is idempotent by a key the client chooses**, spent once per connection. The first request revokes,
 * records what it did, and emits one audit event with the reason. Any later request under that key answers the same,
 * `replayed: true`, revokes nothing — not even a token minted since — and emits nothing. The same key sent for a
 * different revocation is refused as a conflict, never quietly answered with somebody else's result.
 */
export function registerArtifactsAdminRoutes(app: Hono<PithyHonoEnv>, config: ArtifactsConfig): void {
  const base = config.basePath;

  /** A repository the kit knows, or the one 404. */
  async function known(store: ArtifactsStore, name: string): Promise<ArtifactsRepoRecord> {
    const repo = await store.getRepo(name);
    if (!repo) throw new ArtifactsNotFoundError({ detail: `no repository ${name}` });
    return repo;
  }

  /**
   * One revocation, under its idempotency key. `act` runs only for an unspent key, against a repository the kit
   * knows, and answers how many tokens it took back.
   */
  async function revocation(
    c: Context<PithyHonoEnv>,
    target: { kind: ArtifactsRevocationKind; name: string; tokenId: string | null },
    body: AdminRevokeBody,
    act: (repo: ArtifactsRepoRecord) => Promise<{ revoked: number; facts: Record<string, string | number | null> }>,
  ): Promise<AdminRevocation> {
    const caller = controlPlaneCaller(c);
    const store = storeOf(c);
    const spent = await store.getRevocation(caller.connectionId, body.idempotencyKey);
    if (spent) return replay(spent, target);

    const repo = await known(store, target.name);
    const { revoked, facts } = await act(repo);
    const record: ArtifactsRevocationRecord = {
      connectionId: caller.connectionId,
      idempotencyKey: body.idempotencyKey,
      kind: target.kind,
      repo: target.name,
      tokenId: target.tokenId,
      reason: body.reason,
      revoked,
      createdAt: new Date(),
    };
    // Two concurrent requests under one key both reach here; the primary key lets exactly one record and emit.
    if (!(await store.insertRevocation(record))) {
      const winner = await store.getRevocation(caller.connectionId, body.idempotencyKey);
      if (!winner) throw new InternalError({ detail: `revocation ${body.idempotencyKey} vanished after its conflict` });
      return replay(winner, target);
    }
    const action: ArtifactsAuditAction =
      target.kind === "token" ? ArtifactsAuditActions.tokenRevoked : ArtifactsAuditActions.tokensRevoked;
    await recordArtifactsAction(c.var.emit, {
      action,
      actorType: "control-plane",
      actorId: caller.subject,
      repo: repo.name,
      tenant: repo.ownerKind === "org" ? repo.ownerId : null,
      facts: {
        connectionId: caller.connectionId,
        idempotencyKey: body.idempotencyKey,
        reason: body.reason,
        revoked,
        ...facts,
      },
    });
    return revocationView(record, false);
  }

  app.get(
    `${base}/admin/repos`,
    describeRoute({
      summary: "Page every repository, newest first, with its owner, remote access and last push.",
      description:
        "Every owner's, not the caller's: a management client is nobody's. The last push is what Cloudflare holds, and is absent for a repository it could not answer for.",
      verification: "control-plane",
      scopes: [ARTIFACTS_REPOS_READ_SCOPE],
      responses: { 200: AdminRepoList },
    }),
    requireControlPlane(ARTIFACTS_REPOS_READ_SCOPE),
    validate("query", AdminReposQuery),
    async (c) => {
      const query = c.req.valid("query");
      const page = await storeOf(c).listRepos({
        ...(query.cursor !== undefined ? { cursor: query.cursor } : {}),
        ...(query.limit !== undefined ? { limit: query.limit } : {}),
      });
      const binding = artifactsBinding(c.env, config.binding);
      // One repository Cloudflare cannot answer for costs that row its last push, never the whole page.
      const repos = await Promise.all(
        page.items.map(async (repo) =>
          adminRepoView(repo, await withRepo(binding, repo.name, (handle) => handle.info()).catch(() => undefined)),
        ),
      );
      return c.json({ repos, nextCursor: page.nextCursor } satisfies AdminRepoList);
    },
  );

  app.get(
    `${base}/admin/repos/:name`,
    describeRoute({
      summary: "Read one repository: its metadata, its grants, and a page of its commit log.",
      description: "The log comes from Cloudflare's `log()`, newest first, paged by `limit` and `offset`.",
      verification: "control-plane",
      scopes: [ARTIFACTS_REPOS_READ_SCOPE],
      responses: { 200: AdminRepoDetail },
    }),
    requireControlPlane(ARTIFACTS_REPOS_READ_SCOPE),
    validate("param", RepoParams),
    validate("query", AdminRepoQuery),
    async (c) => {
      const store = storeOf(c);
      const repo = await known(store, c.req.valid("param").name);
      const query = c.req.valid("query");
      const limit = query.limit ?? DEFAULT_PAGE_SIZE;
      const offset = query.offset ?? 0;
      const binding = artifactsBinding(c.env, config.binding);
      const { info, commits } = await withRepo(binding, repo.name, async (handle) => ({
        info: await handle.info(),
        // One more than asked for: the extra commit is how "is there another page" is answered.
        commits: await handle.log({ ...(query.ref !== undefined ? { ref: query.ref } : {}), limit: limit + 1, offset }),
      }));
      const grants = await store.listGrants(repo.name);
      return c.json({
        repo: adminRepoDetailView(repo, info),
        grants: grants.map(grantView),
        commits: commits.slice(0, limit).map(commitView),
        nextOffset: commits.length > limit ? offset + limit : null,
      } satisfies AdminRepoDetail);
    },
  );

  app.get(
    `${base}/admin/repos/:name/tokens`,
    describeRoute({
      summary: "List every token on one repository, with its holder where the kit minted it.",
      description:
        "Every token Cloudflare lists, with its scope, state, creation and expiry. A token the kit did not mint is reported as minted outside Pithy and never given a holder. No value is ever returned.",
      verification: "control-plane",
      scopes: [ARTIFACTS_REPOS_READ_SCOPE],
      responses: { 200: AdminTokenList },
    }),
    requireControlPlane(ARTIFACTS_REPOS_READ_SCOPE),
    validate("param", RepoParams),
    async (c) => {
      const store = storeOf(c);
      const repo = await known(store, c.req.valid("param").name);
      const binding = artifactsBinding(c.env, config.binding);
      const listed = await withRepo(binding, repo.name, (handle) => handle.listTokens());
      const records = new Map((await store.tokenRecords(repo.name)).map((record) => [record.id, record]));
      const began = await store.tokenRecordsBegan();
      const now = new Date();
      return c.json({
        tokens: listed.tokens.map((token) => adminTokenView(token, records.get(token.id), now, began)),
        total: listed.total,
      } satisfies AdminTokenList);
    },
  );

  app.post(
    `${base}/admin/repos/:name/tokens/:tokenId/revoke`,
    describeRoute({
      summary: "Revoke one token on a repository, with an idempotency key and a reason.",
      description:
        "A git client holding it is refused on its next request. A replay under the same key answers what the first request did and revokes nothing. A token the repository does not hold is a 404 and spends no key.",
      verification: "control-plane",
      scopes: [ARTIFACTS_TOKENS_REVOKE_SCOPE],
      responses: { 200: AdminRevocation },
    }),
    requireControlPlane(ARTIFACTS_TOKENS_REVOKE_SCOPE),
    validate("param", AdminTokenParams),
    validate("json", AdminRevokeBody),
    async (c) => {
      const { name, tokenId } = c.req.valid("param");
      const body = c.req.valid("json");
      const store = storeOf(c);
      const binding = artifactsBinding(c.env, config.binding);
      const view = await revocation(c, { kind: "token", name, tokenId }, body, async (repo) => {
        const revoked = await withRepo(binding, repo.name, async (handle) => {
          if (await handle.revokeToken(tokenId)) return 1;
          // Revoked nothing: either it is already not live, which is the state asked for, or it was never here.
          const listed = await handle.listTokens();
          if (!listed.tokens.some((token) => token.id === tokenId)) {
            throw new NotFoundError({
              message: "That token does not exist on this repository.",
              detail: `no token ${tokenId} on repository ${repo.name}`,
            });
          }
          return 0;
        });
        const holder = (await store.tokenRecords(repo.name)).find((record) => record.id === tokenId);
        return { revoked, facts: { tokenId, holderId: holder?.userId ?? null } };
      });
      return c.json(view satisfies AdminRevocation);
    },
  );

  app.post(
    `${base}/admin/repos/:name/tokens/revoke`,
    describeRoute({
      summary: "Revoke every live token on a repository, with an idempotency key and a reason.",
      description:
        "Every git client holding one is refused on its next request and must mint again. A replay under the same key answers what the first request did, and revokes nothing minted since.",
      verification: "control-plane",
      scopes: [ARTIFACTS_TOKENS_REVOKE_SCOPE],
      responses: { 200: AdminRevocation },
    }),
    requireControlPlane(ARTIFACTS_TOKENS_REVOKE_SCOPE),
    validate("param", RepoParams),
    validate("json", AdminRevokeBody),
    async (c) => {
      const { name } = c.req.valid("param");
      const store = storeOf(c);
      const binding = artifactsBinding(c.env, config.binding);
      const view = await revocation(c, { kind: "all", name, tokenId: null }, c.req.valid("json"), async (repo) => {
        // Every token the kit handed out, by its record, then whatever the listing still shows live.
        const recorded = await store.unexpiredTokenIds(repo.name, new Date());
        return {
          revoked: await withRepo(binding, repo.name, (handle) => revokeEveryToken(handle, recorded)),
          facts: {},
        };
      });
      return c.json(view satisfies AdminRevocation);
    },
  );
}

/**
 * Answer a spent key: what the first request did, `replayed`, and nothing done now. A key spent on a different
 * revocation is a conflict — answering it would report somebody else's result as this one's.
 */
function replay(
  spent: ArtifactsRevocationRecord,
  target: { kind: ArtifactsRevocationKind; name: string; tokenId: string | null },
): AdminRevocation {
  if (spent.kind !== target.kind || spent.repo !== target.name || spent.tokenId !== target.tokenId) {
    throw new ConflictError({
      message: "That idempotency key was already used for a different revocation.",
      detail: `key spent on ${spent.kind} ${spent.repo}/${spent.tokenId ?? "*"}; asked for ${target.kind} ${target.name}/${target.tokenId ?? "*"}`,
    });
  }
  return revocationView(spent, true);
}

/**
 * The verified management client behind a call. `requireControlPlane()` has run on every route that calls this, so a
 * null context is a wiring mistake rather than an unverified request — hence `InternalError`, not a 401.
 */
function controlPlaneCaller(c: Context<PithyHonoEnv>): ControlPlaneContext {
  const caller = c.var.controlPlane;
  if (!caller) {
    throw new InternalError({
      detail: "requireControlPlane() must run before an artifacts management handler reads the caller.",
    });
  }
  return caller;
}

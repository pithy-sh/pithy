// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import type { PithyHonoEnv } from "@pithy-sh/core/src/capability/capability";
import { InternalError, NotFoundError, UpstreamError } from "@pithy-sh/core/src/error/pithyError";
import { describeRoute } from "@pithy-sh/core/src/http/routeSpec";
import { validate } from "@pithy-sh/core/src/http/validation";
import type { Context, Hono } from "hono";
import { type ArtifactsAccess, accessTo, tokenScope } from "../access/access";
import { type ArtifactsAuditAction, ArtifactsAuditActions, recordArtifactsAction } from "../audit/actions";
import {
  type ArtifactsNamespaceBinding,
  artifactsBinding,
  callArtifacts,
  revokeEveryToken,
  withRepo,
} from "../binding/artifacts";
import type { ArtifactsConfig } from "../config/config";
import { type ArtifactsOwnerKind, type ArtifactsRepoRecord, TOKEN_RECORD_RETENTION_MS } from "../data/records";
import type { ArtifactsStore } from "../data/store";
import {
  ArtifactsForbiddenError,
  ArtifactsInvalidNameError,
  ArtifactsNameTakenError,
  ArtifactsNotFoundError,
} from "../error/errors";
import { assertRepoName, generatedRepoName } from "../naming/repoName";
import { registerArtifactsAdminRoutes } from "./adminRoutes";
import { storeOf } from "./context";
import { requireAuth, requireManagePower } from "./guard";
import {
  CommitView,
  GrantView,
  LogView,
  RepoCredential,
  RepoDetail,
  RepoList,
  RepoView,
  RevokedTokens,
  TreeView,
} from "./responses";
import { CreateRepoBody, FileQuery, GrantParams, LogQuery, ObjectParams, RepoParams, SetGrantBody } from "./schemas";
import { commitView, grantView, repoDetail, repoView } from "./views";

/**
 * The repository routes, mounted at `basePath` (default `/artifacts`).
 *
 * | Method | Path | Who | What |
 * |---|---|---|---|
 * | POST | `/repos` | any signed-in person | Create a repository they own. |
 * | GET | `/repos` | any signed-in person | What they own and what they are granted. |
 * | GET | `/repos/:name` | owner or grant | The row, and what Cloudflare holds. |
 * | DELETE | `/repos/:name` | owner | Delete the repository and its rows. |
 * | POST | `/repos/:name/grants` | owner | Make or change a grant. |
 * | DELETE | `/repos/:name/grants/:userId` | owner | Take a grant away. |
 * | POST | `/repos/:name/credentials` | owner or grant | Mint a token at the caller's scope. 404 with remote access off. |
 * | DELETE | `/repos/:name/credentials` | owner | Revoke every live token. |
 * | GET | `/repos/:name/log`, `/commits/:hash`, `/tree/:hash`, `/blob/:hash`, `/file` | owner or grant | In-Worker reads. |
 * | POST, GET | `/organization/repos` | `managePower` in the acting organization | Only where `organization` is composed. |
 * | GET | `/admin/repos`, `/admin/repos/:name`, `/admin/repos/:name/tokens` | control plane, `artifacts:repos:read` | Every repository, one with its grants and log, and its tokens with their holders. |
 * | POST | `/admin/repos/:name/tokens/:tokenId/revoke`, `/admin/repos/:name/tokens/revoke` | control plane, `artifacts:tokens:revoke` | Revoke one token, or every live one, with an idempotency key and a reason. |
 *
 * **A caller with no grant and no ownership gets the 404 a repository that does not exist gets, byte for byte.** The
 * name is in the clone URL; a refusal that told the two apart would hand it over. A caller who can see a repository
 * and may not do something to it gets a 403, because by then they know it exists.
 */

/** The `repoName` seam: the adopter's own convention for a physical name. Uniqueness is then theirs. */
export type RepoNameSeam = (input: {
  /** Who will own the repository. */
  owner: { kind: ArtifactsOwnerKind; id: string };
  /** The display name the caller asked for. */
  displayName: string;
}) => string;

export interface ArtifactsRoutesOptions {
  /** The resolved config. */
  config: ArtifactsConfig;
  /** The adopter's naming convention, when they have one. */
  repoName?: RepoNameSeam;
  /**
   * Whether `@pithy-sh/organization` is composed in this Worker — read when the routes mount, after every
   * capability's `compose` has run. Without it every repository is a person's and the organization routes do not
   * exist.
   */
  organization: () => boolean;
}

/** One request's view of one repository: its row, what the caller may do, and how to reach it. */
interface Resolved {
  repo: ArtifactsRepoRecord;
  access: ArtifactsAccess;
  store: ArtifactsStore;
  binding: ArtifactsNamespaceBinding;
  userId: string;
}

/** The headers every credential response carries: it is a secret, so nothing between here and the caller keeps it. */
const NO_STORE = { "Cache-Control": "no-store", Pragma: "no-cache" } as const;

/**
 * The headers a repository's bytes are served with. The bytes are whatever somebody pushed, served from this app's
 * own origin, so they are told to be inert: never sniffed into something executable, never rendered with this
 * origin's authority, and saved rather than opened.
 */
const INERT_BYTES = {
  "X-Content-Type-Options": "nosniff",
  "Content-Security-Policy": "default-src 'none'; sandbox",
  "Content-Disposition": "attachment",
} as const;

export function registerArtifactsRoutes(options: ArtifactsRoutesOptions): (app: Hono<PithyHonoEnv>) => void {
  const { config } = options;
  const base = config.basePath;

  return (app) => {
    const organization = options.organization();
    // Read here, once the composition is known, so the access check and the routes agree on it.
    const managePower = organization ? config.managePower : undefined;

    // The management surface: control-plane only, under `admin/`, and mounted whatever is composed.
    registerArtifactsAdminRoutes(app, config);

    /** Who the caller is to the repository in the path, or the one 404. */
    async function resolve(c: Context<PithyHonoEnv>, name: string): Promise<Resolved> {
      const userId = signedIn(c);
      const store = storeOf(c);
      const repo = await store.getRepo(name);
      if (!repo) throw new ArtifactsNotFoundError({ detail: `no repository ${name}` });
      const acting = repo.ownerKind === "org" && organization ? await c.var.actingOrganization() : null;
      // Ownership first, so an owner never reads a grant row at all; then the grant, decoded and refused.
      let access = accessTo({ repo, userId, grant: undefined, acting, managePower });
      if (access === null) {
        const grant = await store.getGrant(name, userId);
        access = accessTo({ repo, userId, grant: grant?.grant, acting, managePower });
      }
      if (access === null) {
        throw new ArtifactsNotFoundError({ detail: `user ${userId} neither owns nor holds a grant on ${name}` });
      }
      return { repo, access, store, binding: artifactsBinding(c.env, config.binding), userId };
    }

    /** The owner, or a 403 for somebody who can see it and may not do this. */
    function requireOwner(resolved: Resolved, what: string): void {
      if (resolved.access === "owner") return;
      throw new ArtifactsForbiddenError({
        detail: `user ${resolved.userId} holds ${resolved.access} and asked to ${what}`,
      });
    }

    /** Record an act on a repository, against its organization when one owns it. */
    function record(
      c: Context<PithyHonoEnv>,
      resolved: Pick<Resolved, "repo" | "userId">,
      action: ArtifactsAuditAction,
      facts?: Record<string, string | number | boolean | null>,
    ): Promise<void> {
      return recordArtifactsAction(c.var.emit, {
        action,
        actorId: resolved.userId,
        repo: resolved.repo.name,
        tenant: resolved.repo.ownerKind === "org" ? resolved.repo.ownerId : null,
        ...(facts ? { facts } : {}),
      });
    }

    /**
     * Create a repository for an owner: name it, create it, revoke the token Cloudflare hands back with it, and
     * record it. The display name is checked first so a duplicate costs no repository. A failed revoke, or a race past
     * that check caught by the unique index, deletes the repository just created again.
     */
    async function create(
      c: Context<PithyHonoEnv>,
      owner: { kind: ArtifactsOwnerKind; id: string },
      body: CreateRepoBody,
    ): Promise<RepoView> {
      const userId = signedIn(c);
      const store = storeOf(c);
      const binding = artifactsBinding(c.env, config.binding);
      if (body.name !== undefined && !config.acceptRepoName) {
        throw new ArtifactsInvalidNameError({
          message: "This Worker names repositories itself. Omit `name`.",
          detail: "a create request supplied a physical name and acceptRepoName is off",
        });
      }
      const name = assertRepoName(
        body.name ?? options.repoName?.({ owner, displayName: body.displayName }) ?? generatedRepoName(),
      );
      if (await store.displayNameTaken(owner.kind, owner.id, body.displayName)) {
        throw new ArtifactsNameTakenError({
          message: "You already have a repository with that name.",
          detail: `${owner.kind}:${owner.id} already holds display name ${JSON.stringify(body.displayName)}`,
        });
      }
      const created = await callArtifacts(`create repository ${name}`, () =>
        binding.create(name, body.description === undefined ? undefined : { description: body.description }),
      );
      const at = new Date();
      const row: ArtifactsRepoRecord = {
        name,
        displayName: body.displayName,
        ownerKind: owner.kind,
        ownerId: owner.id,
        remoteAccess: body.remoteAccess,
        createdAt: at,
        updatedAt: at,
      };
      // **Cloudflare answers a create with a token: write scope, a day's life.** That is a long-lived credential this
      // capability never issues, so it is revoked before anybody can have read it. A revoke that fails, or answers
      // that it revoked nothing, deletes the repository again: with no row, nothing could ever reach it to try again.
      //
      // **And it is recorded, against the creator**, so the token list names it as the kit's own rather than as one
      // minted outside Pithy.
      //
      // **A failure takes back only what this request wrote.** The row goes only once this request inserted it: a
      // name-taken insert means the row is somebody else's, whose Cloudflare repository went out of band. And the
      // Cloudflare delete runs whatever D1 does, so a database that cannot take its row back still leaks no repository.
      let inserted = false;
      try {
        const { revoked, tokens } = await withRepo(binding, name, async (repo) => {
          const revoked = await repo.revokeToken(created.token);
          return { revoked, tokens: revoked ? (await repo.listTokens()).tokens : [] };
        });
        if (!revoked) {
          throw new UpstreamError({
            message: "Cloudflare Artifacts could not complete the request.",
            detail: `revoke the create token of repository ${name}: the binding answered false`,
          });
        }
        await store.insertRepo(row);
        inserted = true;
        await store.recordTokens(
          tokens.map((token) => ({
            id: token.id,
            repo: name,
            userId,
            scope: token.scope,
            source: "create" as const,
            createdAt: at,
            expiresAt: new Date(token.expiresAt),
          })),
        );
      } catch (error) {
        try {
          if (inserted) await store.deleteRepo(name);
        } finally {
          await callArtifacts(`delete repository ${name}`, () => binding.delete(name));
        }
        throw error;
      }
      await record(c, { repo: row, userId }, ArtifactsAuditActions.repoCreated, {
        displayName: row.displayName,
        remoteAccess: row.remoteAccess,
      });
      return repoView(row, "owner");
    }

    app.post(
      `${base}/repos`,
      describeRoute({
        summary: "Create a repository you own.",
        description:
          "The physical name is a random UUID, unless this Worker is configured to take one. The token Cloudflare creates with the repository is revoked before this answers.",
        verification: ["bearer", "session"],
        responses: { 201: RepoView },
      }),
      requireAuth(),
      validate("json", CreateRepoBody),
      async (c) => {
        const body = c.req.valid("json");
        return c.json((await create(c, { kind: "user", id: signedIn(c) }, body)) satisfies RepoView, 201);
      },
    );

    app.get(
      `${base}/repos`,
      describeRoute({
        summary: "List the repositories you own or hold a grant on.",
        verification: ["bearer", "session"],
        responses: { 200: RepoList },
      }),
      requireAuth(),
      async (c) => {
        const visible = await storeOf(c).listVisible(signedIn(c));
        return c.json({
          repos: visible.map((entry) => repoView(entry.repo, entry.grant ?? "owner")),
        } satisfies RepoList);
      },
    );

    if (organization && config.managePower !== undefined) {
      const power = config.managePower;

      app.post(
        `${base}/organization/repos`,
        describeRoute({
          summary: "Create a repository the organization you act for owns.",
          description: `Requires the configured \`managePower\` in the organization in force.`,
          verification: ["bearer", "session"],
          responses: { 201: RepoView },
        }),
        requireAuth(),
        requireManagePower(power),
        validate("json", CreateRepoBody),
        async (c) => {
          const acting = await c.var.actingOrganization();
          if (acting === null)
            throw new InternalError({ detail: "requireManagePower let a request through with no organization" });
          const body = c.req.valid("json");
          return c.json((await create(c, { kind: "org", id: acting.organizationId }, body)) satisfies RepoView, 201);
        },
      );

      app.get(
        `${base}/organization/repos`,
        describeRoute({
          summary: "List the repositories the organization you act for owns.",
          description: `Requires the configured \`managePower\` in the organization in force.`,
          verification: ["bearer", "session"],
          responses: { 200: RepoList },
        }),
        requireAuth(),
        requireManagePower(power),
        async (c) => {
          const acting = await c.var.actingOrganization();
          if (acting === null)
            throw new InternalError({ detail: "requireManagePower let a request through with no organization" });
          const owned = await storeOf(c).listOwned("org", acting.organizationId);
          return c.json({ repos: owned.map((repo) => repoView(repo, "owner")) } satisfies RepoList);
        },
      );
    }

    app.get(
      `${base}/repos/:name`,
      describeRoute({
        summary: "Read a repository: its row, and what Cloudflare holds about it.",
        description: "The clone URL is absent when remote access is off.",
        verification: ["bearer", "session"],
        responses: { 200: RepoDetail },
      }),
      requireAuth(),
      validate("param", RepoParams),
      async (c) => {
        const resolved = await resolve(c, c.req.valid("param").name);
        const info = await withRepo(resolved.binding, resolved.repo.name, (repo) => repo.info());
        return c.json(repoDetail(resolved.repo, resolved.access, info) satisfies RepoDetail);
      },
    );

    app.delete(
      `${base}/repos/:name`,
      describeRoute({
        summary: "Delete a repository, every token on it, and every grant.",
        verification: ["bearer", "session"],
        responses: { 204: { description: "The repository is gone." } },
      }),
      requireAuth(),
      validate("param", RepoParams),
      async (c) => {
        const resolved = await resolve(c, c.req.valid("param").name);
        requireOwner(resolved, "delete the repository");
        // Cloudflare first: if it refuses, the rows stay and the owner can try again.
        await callArtifacts(`delete repository ${resolved.repo.name}`, () =>
          resolved.binding.delete(resolved.repo.name),
        );
        await resolved.store.deleteRepo(resolved.repo.name);
        await record(c, resolved, ArtifactsAuditActions.repoDeleted, { displayName: resolved.repo.displayName });
        return c.body(null, 204);
      },
    );

    app.post(
      `${base}/repos/:name/grants`,
      describeRoute({
        summary: "Give a person read or write on a repository, or change what they hold.",
        description: "Tokens already minted at the old scope live out their life. Revoke them to end it now.",
        verification: ["bearer", "session"],
        responses: { 200: GrantView },
      }),
      requireAuth(),
      validate("param", RepoParams),
      validate("json", SetGrantBody),
      async (c) => {
        const resolved = await resolve(c, c.req.valid("param").name);
        requireOwner(resolved, "change a grant");
        const body = c.req.valid("json");
        const at = new Date();
        await resolved.store.setGrant(resolved.repo.name, body.userId, body.grant, at);
        const stored = await resolved.store.getGrant(resolved.repo.name, body.userId);
        if (!stored)
          throw new InternalError({ detail: `grant on ${resolved.repo.name} vanished after it was written` });
        await record(c, resolved, ArtifactsAuditActions.grantSet, { userId: body.userId, grant: body.grant });
        return c.json(grantView(stored) satisfies GrantView);
      },
    );

    app.delete(
      `${base}/repos/:name/grants/:userId`,
      describeRoute({
        summary: "Take a person's grant on a repository away.",
        description:
          "Their next mint is refused. A token they already hold works until it expires, so revoke every token to end it now.",
        verification: ["bearer", "session"],
        responses: { 204: { description: "The person holds no grant on the repository." } },
      }),
      requireAuth(),
      validate("param", GrantParams),
      async (c) => {
        const params = c.req.valid("param");
        const resolved = await resolve(c, params.name);
        requireOwner(resolved, "remove a grant");
        if (await resolved.store.removeGrant(resolved.repo.name, params.userId)) {
          await record(c, resolved, ArtifactsAuditActions.grantRemoved, { userId: params.userId });
        }
        return c.body(null, 204);
      },
    );

    app.post(
      `${base}/repos/:name/credentials`,
      describeRoute({
        summary: "Mint a short-lived git token for a repository, at the scope your grant gives.",
        description:
          "Owners and write grants get `write`; read grants get `read`. The token lives `tokenTtlSeconds`. Answers 404 for a repository with remote access off.",
        verification: ["bearer", "session"],
        responses: { 201: RepoCredential },
      }),
      requireAuth(),
      validate("param", RepoParams),
      async (c) => {
        const resolved = await resolve(c, c.req.valid("param").name);
        // **The same 404 as no repository at all.** Remote access off shuts the git path, and a distinguishable
        // answer would say there is a repository here to shut.
        if (!resolved.repo.remoteAccess) {
          throw new ArtifactsNotFoundError({ detail: `remote access is off for ${resolved.repo.name}` });
        }
        const scope = tokenScope(resolved.access);
        const at = new Date();
        // Records that have outlived any listing of their token go first, so the table is bounded by what is live.
        await resolved.store.pruneTokens(resolved.repo.name, new Date(at.getTime() - TOKEN_RECORD_RETENTION_MS));
        const { minted, remote } = await withRepo(resolved.binding, resolved.repo.name, async (repo) => ({
          minted: await repo.createToken(scope, config.tokenTtlSeconds),
          remote: (await repo.info()).remote,
        }));
        // **A token nobody can name is never handed out.** Its record is written before the response, and a record
        // that cannot be written revokes the token again rather than leave a credential the list cannot attribute.
        try {
          await resolved.store.recordTokens([
            {
              id: minted.id,
              repo: resolved.repo.name,
              userId: resolved.userId,
              scope: minted.scope,
              source: "credential",
              createdAt: at,
              expiresAt: new Date(minted.expiresAt),
            },
          ]);
        } catch (error) {
          await withRepo(resolved.binding, resolved.repo.name, (repo) => repo.revokeToken(minted.id)).catch(
            // The record failure is the one to report. A revoke that fails too leaves the token its TTL, no longer.
            () => false,
          );
          throw new InternalError(
            { detail: `record token ${minted.id} on repository ${resolved.repo.name}` },
            { cause: error },
          );
        }
        await record(c, resolved, ArtifactsAuditActions.tokenMinted, {
          tokenId: minted.id,
          scope: minted.scope,
          expiresAt: minted.expiresAt,
        });
        return c.json(
          {
            token: minted.plaintext,
            scope: minted.scope,
            expiresAt: minted.expiresAt,
            remote,
          } satisfies RepoCredential,
          201,
          NO_STORE,
        );
      },
    );

    app.delete(
      `${base}/repos/:name/credentials`,
      describeRoute({
        summary: "Revoke every live token on a repository.",
        description:
          "The break-glass. Every git client holding one is refused on its next request and must mint again.",
        verification: ["bearer", "session"],
        responses: { 200: RevokedTokens },
      }),
      requireAuth(),
      validate("param", RepoParams),
      async (c) => {
        const resolved = await resolve(c, c.req.valid("param").name);
        requireOwner(resolved, "revoke every token");
        const recorded = await resolved.store.unexpiredTokenIds(resolved.repo.name, new Date());
        const revoked = await withRepo(resolved.binding, resolved.repo.name, (repo) =>
          revokeEveryToken(repo, recorded),
        );
        await record(c, resolved, ArtifactsAuditActions.tokensRevoked, { revoked });
        return c.json({ revoked } satisfies RevokedTokens);
      },
    );

    app.get(
      `${base}/repos/:name/log`,
      describeRoute({
        summary: "Read a repository's history, newest first.",
        description: "Answers whether or not remote access is on.",
        verification: ["bearer", "session"],
        responses: { 200: LogView },
      }),
      requireAuth(),
      validate("param", RepoParams),
      validate("query", LogQuery),
      async (c) => {
        const resolved = await resolve(c, c.req.valid("param").name);
        const query = c.req.valid("query");
        const commits = await withRepo(resolved.binding, resolved.repo.name, (repo) =>
          repo.log({
            ...(query.ref !== undefined ? { ref: query.ref } : {}),
            ...(query.limit !== undefined ? { limit: query.limit } : {}),
            ...(query.offset !== undefined ? { offset: query.offset } : {}),
          }),
        );
        return c.json({ commits: commits.map(commitView) } satisfies LogView);
      },
    );

    app.get(
      `${base}/repos/:name/commits/:hash`,
      describeRoute({
        summary: "Read one commit.",
        verification: ["bearer", "session"],
        responses: { 200: CommitView },
      }),
      requireAuth(),
      validate("param", ObjectParams),
      async (c) => {
        const params = c.req.valid("param");
        const resolved = await resolve(c, params.name);
        const commit = await withRepo(resolved.binding, resolved.repo.name, (repo) => repo.readCommit(params.hash));
        if (!commit) throw noSuchObject(params.hash);
        return c.json(commitView(commit) satisfies CommitView);
      },
    );

    app.get(
      `${base}/repos/:name/tree/:hash`,
      describeRoute({
        summary: "Read one tree's immediate children.",
        verification: ["bearer", "session"],
        responses: { 200: TreeView },
      }),
      requireAuth(),
      validate("param", ObjectParams),
      async (c) => {
        const params = c.req.valid("param");
        const resolved = await resolve(c, params.name);
        const entries = await withRepo(resolved.binding, resolved.repo.name, (repo) => repo.readTree(params.hash));
        if (!entries) throw noSuchObject(params.hash);
        return c.json({
          entries: entries.map(({ name, mode, hash, type }) => ({ name, mode, hash, type })),
        } satisfies TreeView);
      },
    );

    app.get(
      `${base}/repos/:name/blob/:hash`,
      describeRoute({
        summary: "Read one blob's bytes.",
        description: "Served as an attachment, never sniffed, under a sandboxing content security policy.",
        verification: ["bearer", "session"],
        responses: { 200: { description: "The blob's bytes.", contentType: "application/octet-stream" } },
      }),
      requireAuth(),
      validate("param", ObjectParams),
      async (c) => {
        const params = c.req.valid("param");
        const resolved = await resolve(c, params.name);
        const blob = await withRepo(resolved.binding, resolved.repo.name, (repo) => repo.readBlob(params.hash));
        if (!blob) throw noSuchObject(params.hash);
        return c.body(await blob.arrayBuffer(), 200, { ...INERT_BYTES, "Content-Type": "application/octet-stream" });
      },
    );

    app.get(
      `${base}/repos/:name/file`,
      describeRoute({
        summary: "Read one file at a branch, tag or commit.",
        description:
          "Served with the content type Cloudflare resolves for it, as an attachment, never sniffed, under a sandboxing content security policy.",
        verification: ["bearer", "session"],
        responses: { 200: { description: "The file's bytes.", contentType: "application/octet-stream" } },
      }),
      requireAuth(),
      validate("param", RepoParams),
      validate("query", FileQuery),
      async (c) => {
        const resolved = await resolve(c, c.req.valid("param").name);
        const query = c.req.valid("query");
        const file = await withRepo(resolved.binding, resolved.repo.name, (repo) =>
          repo.readFile({ ref: query.ref, path: query.path }),
        );
        if (!file) throw new NotFoundError({ message: "That file does not exist at that ref." });
        return c.body(await file.arrayBuffer(), 200, {
          ...INERT_BYTES,
          "Content-Type": file.type || "application/octet-stream",
        });
      },
    );
  };
}

/** A Git object the caller may look for and that is not there. The repository exists; the caller can see it. */
function noSuchObject(hash: string): NotFoundError {
  return new NotFoundError({ message: "That object does not exist in this repository.", detail: `no object ${hash}` });
}

function signedIn(c: Context<PithyHonoEnv>): string {
  const auth = c.var.auth;
  if (!auth) throw new InternalError({ detail: "requireAuth() must run before a handler reads the user id." });
  return auth.userId;
}

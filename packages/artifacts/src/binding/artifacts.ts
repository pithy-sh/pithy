// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { InternalError, PithyError, UpstreamError } from "@pithy-sh/core/src/error/pithyError";
import { ArtifactsInvalidNameError, ArtifactsNameTakenError, ArtifactsNotFoundError } from "../error/errors";

/**
 * **The slice of the Artifacts Workers binding this capability calls**, stated structurally.
 *
 * Cloudflare's `Artifacts` type (`@cloudflare/workers-types`) is the source, and `artifacts.test.ts` holds it
 * assignable to these, so a binding that stops answering one of them is a type error here rather than a 500 later.
 * Stated rather than imported so a project on an older workers-types still compiles the published declarations, and
 * so a test can stand one up: Miniflare has no Artifacts simulation. `fork` and `import` are left out on purpose —
 * neither is needed to hand somebody a repository.
 */

/** A token's scope, as Cloudflare spells it. */
export type ArtifactsTokenScope = "read" | "write";

/** What `createToken` answers. `plaintext` is the credential, returned once and never stored. */
export interface ArtifactsMintedToken {
  id: string;
  plaintext: string;
  scope: ArtifactsTokenScope;
  expiresAt: string;
}

/** One token's metadata, without its plaintext. */
export interface ArtifactsTokenMetadata {
  id: string;
  scope: ArtifactsTokenScope;
  state: "active" | "expired" | "revoked";
  createdAt: string;
  expiresAt: string;
}

/** What `info()` answers. `remote` is the clone URL. */
export interface ArtifactsRepoMetadata {
  id: string;
  name: string;
  description: string | null;
  defaultBranch: string;
  createdAt: string;
  updatedAt: string;
  lastPushAt: string | null;
  source: string | null;
  readOnly: boolean;
  remote: string;
}

/** One entry of a tree. */
export interface ArtifactsTreeEntryMetadata {
  name: string;
  mode: string;
  hash: string;
  type: "tree" | "blob" | "symlink" | "gitlink" | "exec";
}

/** A decoded commit. */
export interface ArtifactsCommitMetadataShape {
  hash: string;
  treeHash: string;
  message: string;
  author: { name: string; email: string };
  committer: { name: string; email: string };
  parents: string[];
  authoredAt: number;
  committedAt: number;
}

/** A handle to one repository, as `get(name)` returns it. An RPC stub: dispose of it when done. */
export interface ArtifactsRepoHandle {
  createToken(scope?: ArtifactsTokenScope, ttl?: number): Promise<ArtifactsMintedToken>;
  listTokens(): Promise<{ tokens: ArtifactsTokenMetadata[]; total: number }>;
  revokeToken(tokenOrId: string): Promise<boolean>;
  info(): Promise<ArtifactsRepoMetadata>;
  readBlob(hash: string): Promise<Blob | null>;
  readTree(hash: string): Promise<ArtifactsTreeEntryMetadata[] | null>;
  readCommit(hash: string): Promise<ArtifactsCommitMetadataShape | null>;
  readFile(args: { ref: string; path: string }): Promise<Blob | null>;
  log(opts?: { ref?: string; limit?: number; offset?: number }): Promise<ArtifactsCommitMetadataShape[]>;
}

/** The namespace-level binding, `env.ARTIFACTS`. */
export interface ArtifactsNamespaceBinding {
  create(
    name: string,
    opts?: { readOnly?: boolean; description?: string; setDefaultBranch?: string },
  ): Promise<{ name: string; remote: string; token: string; defaultBranch: string }>;
  get(name: string): Promise<ArtifactsRepoHandle>;
  delete(name: string): Promise<boolean>;
}

/** The binding off this invocation's env, or an operator-facing refusal naming it. */
export function artifactsBinding(env: Record<string, unknown>, name: string): ArtifactsNamespaceBinding {
  const binding = env[name];
  if (binding === undefined || binding === null) {
    throw new InternalError({
      message: "The Artifacts namespace is not configured.",
      action: `Bind an artifacts namespace named ${name} in wrangler.jsonc, then redeploy.`,
      detail: `the artifacts capability requires an "${name}" artifacts binding; none was present on env`,
    });
  }
  return binding as ArtifactsNamespaceBinding;
}

/**
 * Open a repository, run `work` on it, and release the RPC stub however `work` ends. Cloudflare asks for the stub to
 * be disposed before the request ends; a `finally` does that without depending on `using` reaching every runtime.
 */
export async function withRepo<T>(
  binding: ArtifactsNamespaceBinding,
  name: string,
  work: (repo: ArtifactsRepoHandle) => Promise<T>,
): Promise<T> {
  const repo = await callArtifacts(`open repository ${name}`, () => binding.get(name));
  try {
    return await callArtifacts(`use repository ${name}`, () => work(repo));
  } finally {
    (repo as Partial<Disposable>)[Symbol.dispose]?.();
  }
}

/** The `code` an `ArtifactsError` carries, or `undefined` for anything else. */
export function artifactsErrorCode(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null) return undefined;
  const candidate = error as { name?: unknown; code?: unknown };
  return candidate.name === "ArtifactsError" && typeof candidate.code === "string" ? candidate.code : undefined;
}

/**
 * **One call into the binding, its failure translated.** A repository gone from under its row is the same 404 as
 * any other. A name Cloudflare refuses is `artifacts/invalid_name`, and one it already holds is
 * `artifacts/name_taken`. Everything else is Cloudflare's, so it is `core/upstream_failed`: the fault is not in this
 * Worker's logs. The operation is named in `detail` and never carries a token.
 */
export async function callArtifacts<T>(operation: string, call: () => Promise<T>): Promise<T> {
  try {
    return await call();
  } catch (error) {
    if (error instanceof PithyError) throw error;
    const code = artifactsErrorCode(error);
    const detail = `${operation}: ArtifactsError ${code ?? "unknown"}`;
    if (code === "NOT_FOUND") throw new ArtifactsNotFoundError({ detail }, { cause: error });
    if (code === "INVALID_REPO_NAME") throw new ArtifactsInvalidNameError({ detail }, { cause: error });
    if (code === "ALREADY_EXISTS") throw new ArtifactsNameTakenError({ detail }, { cause: error });
    throw new UpstreamError(
      { message: "Cloudflare Artifacts could not complete the request.", detail },
      { cause: error },
    );
  }
}

/**
 * **Revoke every live token on a repository**: each one the kit recorded, by its id, then whatever the listing still
 * shows live.
 *
 * The records come first because the listing cannot be trusted to reach them. `listTokens` answers one page with no
 * cursor, so the only way past the first page is to revoke what it shows and ask again, and that works only while the
 * listing leaves revoked tokens out. A listing that keeps them answers the same first page again, now dead, and the
 * loop ends with live tokens past it. The kit records every token it hands out before the plaintext leaves the Worker,
 * and keeps the record past the token's expiry, so revoking by record reaches every token the kit minted whatever the
 * listing shows. Pass the ids of the records that have not yet expired.
 *
 * The listing loop then catches a live token nobody recorded: one minted on the binding by your own code, or over
 * Cloudflare's REST API. That half still reaches past the first page only while the listing leaves revoked tokens out.
 * A round that revokes nothing ends it, rather than asking again forever. A recorded token that was already dead
 * answers `false` and counts as nothing.
 */
export async function revokeEveryToken(repo: ArtifactsRepoHandle, recorded: readonly string[] = []): Promise<number> {
  let revoked = 0;
  for (const id of recorded) {
    if (await repo.revokeToken(id)) revoked += 1;
  }
  for (let round = 0; round < 50; round += 1) {
    const live = (await repo.listTokens()).tokens.filter((token) => token.state === "active");
    let progressed = 0;
    for (const token of live) {
      if (await repo.revokeToken(token.id)) progressed += 1;
    }
    revoked += progressed;
    if (live.length === 0 || progressed === 0) break;
  }
  return revoked;
}

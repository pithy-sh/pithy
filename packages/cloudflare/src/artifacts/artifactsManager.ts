// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { ValidationError } from "@pithy-sh/core/src/error/pithyError";
import { z } from "zod";
import {
  CloudflareInvalidResponseError,
  cloudflareApiErrors,
  cloudflareRefusal,
  cloudflareRequest,
  decodeResponse,
  messageOf,
} from "../client/errors";
import { CloudflareManager } from "../client/manager";

/** The Cloudflare REST API v4 base URL. Artifacts lives under `/accounts/{id}/artifacts`. */
const CF_API_BASE = "https://api.cloudflare.com/client/v4";

/** The most repos one page of `GET …/repos` returns. Cloudflare's own maximum. */
const PAGE_LIMIT = 200;

/**
 * A namespace or repo name, as Cloudflare's limits page states it: a letter or digit, then letters, digits, `.`,
 * `_` and `-`. Asserted before either reaches a path, because a `/` or a `..` there addresses another endpoint.
 */
const ARTIFACTS_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/** What {@link CloudflareArtifactsManager.deleteNamespace} is told by a `409`: a repo is still in the namespace. */
const OCCUPIED = Symbol("occupied");

/** The standard `{ result, success, errors, result_info }` envelope, as far as this reads it. */
const Envelope = z
  .object({
    result: z.unknown().describe("The payload."),
    success: z.boolean().optional().describe("Whether Cloudflare reports the call succeeded."),
    errors: z.array(z.unknown()).optional().describe("Cloudflare's own error entries."),
    result_info: z
      .object({ cursor: z.string().nullable().optional().describe("The next page's cursor, when there is one.") })
      .loose()
      .optional()
      .describe("Pagination, for a listing."),
  })
  .describe("A Cloudflare REST envelope.");

/** One page of `GET …/repos` or `GET …/namespaces`: only the name of each entry is read. */
const NamedPage = z
  .array(z.object({ name: z.string().describe("The repo's or the namespace's name.") }).loose())
  .describe("One page of an Artifacts listing of repos or namespaces.");

/**
 * Account-level Artifacts control plane: **list and delete the repos in a namespace, then the namespace** (#673).
 *
 * Inside a Worker a repo is reached through the `artifacts` binding. This is the other side of that: `pithy feature
 * destroy` reaps every repo in a feature's namespace, because repos cost storage and nothing else ever deletes one.
 * There is no create here, because Cloudflare creates a namespace the first time a repo is created in it and the kit
 * creates repos only from the Worker. There is a namespace delete, because nothing else removes one.
 *
 * The SDK this package targets exposes no Artifacts resource, so this uses the documented escape hatch — the raw
 * token and `fetch` — against the paths [the REST API](https://developers.cloudflare.com/artifacts/api/rest-api/)
 * publishes, and validates what comes back.
 */
export class CloudflareArtifactsManager extends CloudflareManager {
  getServiceType(): string {
    return "Cloudflare Artifacts (control plane)";
  }

  /** Prove access by listing namespaces — a read, never a write. Never throws. */
  async validateServiceAccess(): Promise<boolean> {
    try {
      const response = await this.send("GET", `/accounts/${this.getAccountId()}/artifacts/namespaces?limit=1`);
      return response.ok;
    } catch {
      return false;
    }
  }

  /**
   * Every repo name in a namespace, across every page. **A namespace that does not exist has none**: Cloudflare
   * makes one on its first repo, so a feature that never created a repo has no namespace, and teardown of it is a
   * clean no-op rather than a failure.
   */
  async listRepos(namespace: string): Promise<string[]> {
    assertName(namespace, "namespace");
    return cloudflareRequest(`list Artifacts repos in ${namespace}`, () =>
      this.names(`${this.namespacePath(namespace)}/repos`, "Artifacts repo list"),
    );
  }

  /**
   * Every namespace name on the account, across every page. The live suites' debris sweep reads it to find the
   * `pithy-int-` namespaces an aborted run left behind, since nothing else lists them.
   */
  async listNamespaces(): Promise<string[]> {
    return cloudflareRequest("list Artifacts namespaces", () =>
      this.names(`/accounts/${this.getAccountId()}/artifacts/namespaces`, "Artifacts namespace list"),
    );
  }

  /** Every `name` a paged listing answers, following its cursor. A 404 is an empty listing. */
  private async names(path: string, what: string): Promise<string[]> {
    const names = new Set<string>();
    const followed = new Set<string>();
    let cursor: string | undefined;
    for (;;) {
      const query = `limit=${PAGE_LIMIT}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`;
      const page = await this.call("GET", `${path}?${query}`);
      if (page === null) return [...names];
      for (const entry of decodeResponse(NamedPage, page.result, what)) names.add(entry.name);
      const next = page.result_info?.cursor ?? undefined;
      // A cursor already followed is the last page answering again; stopping there is what keeps a listing
      // that never empties its cursor from looping forever.
      if (!next || followed.has(next)) return [...names];
      followed.add(next);
      cursor = next;
    }
  }

  /**
   * Delete one repo and every token on it. **Resolves whether one was there**, so teardown re-runs safely: a repo
   * already gone is `false`, not an error. Cloudflare answers `202 Accepted`, so the storage may take a moment to
   * be released after this returns.
   */
  async deleteRepo(namespace: string, name: string): Promise<boolean> {
    assertName(namespace, "namespace");
    assertName(name, "repo");
    return cloudflareRequest(`delete Artifacts repo ${namespace}/${name}`, async () => {
      const result = await this.call("DELETE", `${this.namespacePath(namespace)}/repos/${name}`);
      return result !== null;
    });
  }

  /**
   * Delete a namespace, once it is empty. Cloudflare makes one on the first repo and nothing else ever deletes it,
   * so a feature's would outlive the feature. `DELETE /accounts/{id}/artifacts/namespaces/{namespace}` is in
   * Cloudflare's published API schema, not on the Artifacts REST page: it deletes an empty namespace, answers `204`,
   * and answers `409` while a repo remains.
   *
   * **Three answers, none of them a failure of teardown.** `deleted` it was there; `absent` it is already gone or was
   * never created, so a re-run is a clean no-op; `occupied` a repo is still in it — a repo delete is `202 Accepted`,
   * so one just reaped can hold the namespace a moment longer, and the caller decides how long to wait.
   */
  async deleteNamespace(namespace: string): Promise<"deleted" | "absent" | "occupied"> {
    assertName(namespace, "namespace");
    return cloudflareRequest(`delete Artifacts namespace ${namespace}`, async () => {
      const result = await this.call("DELETE", this.namespacePath(namespace), { occupied: true });
      if (result === OCCUPIED) return "occupied";
      return result === null ? "absent" : "deleted";
    });
  }

  private namespacePath(namespace: string): string {
    return `/accounts/${this.getAccountId()}/artifacts/namespaces/${namespace}`;
  }

  private send(method: "GET" | "DELETE", path: string): Promise<Response> {
    return fetch(`${CF_API_BASE}${path}`, { method, headers: { authorization: `Bearer ${this.getApiToken()}` } });
  }

  /**
   * One REST call, its envelope unwrapped. `null` for a 404 — the namespace or the repo is not there, which every
   * caller here reads as nothing to do. {@link OCCUPIED} for a 409 when the caller asks for it — a namespace that
   * still holds a repo. Any other failure is Cloudflare's refusal, in Cloudflare's words.
   */
  private async call(method: "GET" | "DELETE", path: string): Promise<z.output<typeof Envelope> | null>;
  private async call(
    method: "DELETE",
    path: string,
    options: { occupied: true },
  ): Promise<z.output<typeof Envelope> | null | typeof OCCUPIED>;
  private async call(
    method: "GET" | "DELETE",
    path: string,
    options: { occupied?: boolean } = {},
  ): Promise<z.output<typeof Envelope> | null | typeof OCCUPIED> {
    const response = await this.send(method, path);
    if (response.status === 404) return null;
    if (response.status === 409 && options.occupied) return OCCUPIED;
    const text = await response.text();
    // A `204` has no envelope to unwrap: the namespace delete answers that way.
    if (response.ok && text.length === 0) return { result: null };
    let parsed: unknown = {};
    if (text.length > 0) {
      try {
        parsed = JSON.parse(text);
      } catch (error) {
        throw new CloudflareInvalidResponseError({
          message: "A Cloudflare Artifacts response was not valid JSON.",
          detail: `${method} ${path}: ${messageOf(error)}`,
        });
      }
    }
    const envelope = Envelope.safeParse(parsed);
    if (!response.ok || (envelope.success && envelope.data.success === false)) {
      throw cloudflareRefusal({
        problem: `Cloudflare Artifacts returned ${response.status}.`,
        apiErrors: cloudflareApiErrors(envelope.success ? envelope.data.errors : []),
        status: response.status,
        permission: "Artifacts Write",
        detail: `${method} ${path} → ${response.status}: ${text}`.slice(0, 2000),
      });
    }
    return decodeResponse(Envelope, parsed, `Artifacts ${method}`);
  }
}

/** Refuse a name outside Cloudflare's charset before it is put in a path. */
function assertName(value: string, what: "namespace" | "repo"): void {
  if (ARTIFACTS_NAME.test(value)) return;
  throw new ValidationError({
    message: `"${value}" is not an Artifacts ${what} name.`,
    action: "Use a letter or digit, then letters, digits, `.`, `_` and `-`.",
    detail: `An Artifacts ${what} name is interpolated into a REST path, so anything outside the charset is refused.`,
  });
}

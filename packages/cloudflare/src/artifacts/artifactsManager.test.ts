// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CloudflareRequestError } from "../client/errors";
import { CloudflareArtifactsManager } from "./artifactsManager";

/** A Cloudflare v4 envelope, as the Artifacts REST API answers. */
function envelope(result: unknown, status = 200, extra: Record<string, unknown> = {}): Response {
  return new Response(JSON.stringify({ success: status < 400, errors: [], messages: [], result, ...extra }), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function refusal(status: number, code: number, message: string): Response {
  return new Response(JSON.stringify({ success: false, errors: [{ code, message }], messages: [], result: null }), {
    status,
  });
}

/** One repo as `GET …/repos` lists it. Only `name` is read; the rest is there to be ignored. */
function repo(name: string): Record<string, unknown> {
  return { id: `id-${name}`, name, description: null, default_branch: "main", read_only: false, remote: "x" };
}

describe("CloudflareArtifactsManager", () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  const manager = () => new CloudflareArtifactsManager({ accountId: "acct-1", apiToken: "tok-1" });

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("lists every repo in a namespace, following the cursor to the last page", async () => {
    fetchMock
      .mockResolvedValueOnce(envelope([repo("a"), repo("b")], 200, { result_info: { cursor: "c2", count: 2 } }))
      .mockResolvedValueOnce(envelope([repo("c")], 200, { result_info: { cursor: "", count: 1 } }));
    expect(await manager().listRepos("acme-f662-thing--artifacts")).toEqual(["a", "b", "c"]);
    const [first, init] = fetchMock.mock.calls[0] ?? [];
    expect(first).toBe(
      "https://api.cloudflare.com/client/v4/accounts/acct-1/artifacts/namespaces/acme-f662-thing--artifacts/repos?limit=200",
    );
    expect((init as RequestInit).method).toBe("GET");
    expect(((init as RequestInit).headers as Record<string, string>).authorization).toBe("Bearer tok-1");
    expect(fetchMock.mock.calls[1]?.[0]).toBe(
      "https://api.cloudflare.com/client/v4/accounts/acct-1/artifacts/namespaces/acme-f662-thing--artifacts/repos?limit=200&cursor=c2",
    );
  });

  it("stops on a cursor it has already followed, rather than looping", async () => {
    fetchMock.mockImplementation(async () => envelope([repo("a")], 200, { result_info: { cursor: "same" } }));
    expect(await manager().listRepos("ns")).toEqual(["a"]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("answers an empty list for a namespace that does not exist, which Cloudflare makes on the first repo", async () => {
    fetchMock.mockResolvedValue(refusal(404, 10404, "Namespace not found"));
    expect(await manager().listRepos("ns")).toEqual([]);
  });

  it("deletes one repo by name, and says whether one was there", async () => {
    fetchMock.mockResolvedValueOnce(envelope({ id: "repo_1" }, 202));
    expect(await manager().deleteRepo("ns", "docs")).toBe(true);
    const [url, init] = fetchMock.mock.calls[0] ?? [];
    expect(url).toBe("https://api.cloudflare.com/client/v4/accounts/acct-1/artifacts/namespaces/ns/repos/docs");
    expect((init as RequestInit).method).toBe("DELETE");
    fetchMock.mockResolvedValueOnce(refusal(404, 10404, "Repo not found"));
    expect(await manager().deleteRepo("ns", "docs")).toBe(false);
  });

  it("deletes an empty namespace, and says it was there", async () => {
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 204 }));
    expect(await manager().deleteNamespace("acme-f662-thing--artifacts")).toBe("deleted");
    const [url, init] = fetchMock.mock.calls[0] ?? [];
    expect(url).toBe(
      "https://api.cloudflare.com/client/v4/accounts/acct-1/artifacts/namespaces/acme-f662-thing--artifacts",
    );
    expect((init as RequestInit).method).toBe("DELETE");
  });

  it("answers absent for a namespace already gone or never created, rather than failing", async () => {
    fetchMock.mockResolvedValueOnce(refusal(404, 10404, "Namespace not found"));
    expect(await manager().deleteNamespace("ns")).toBe("absent");
  });

  it("answers occupied for a namespace that still holds a repo, so the caller can wait for a repo delete to land", async () => {
    fetchMock.mockResolvedValueOnce(refusal(409, 10409, "Namespace is not empty"));
    expect(await manager().deleteNamespace("ns")).toBe("occupied");
  });

  it("raises any other refusal of a namespace delete, with Cloudflare's own words", async () => {
    fetchMock.mockResolvedValueOnce(refusal(403, 10000, "Authentication error"));
    await expect(manager().deleteNamespace("ns")).rejects.toThrow(/Authentication error/);
  });

  it("refuses a namespace or repo name outside the charset rather than putting it in a path", async () => {
    await expect(manager().listRepos("../tokens")).rejects.toThrow();
    await expect(manager().deleteRepo("ns", "a/b")).rejects.toThrow();
    await expect(manager().deleteNamespace("..")).rejects.toThrow();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("raises any other refusal, with Cloudflare's own words", async () => {
    fetchMock.mockImplementation(async () => refusal(403, 10000, "Authentication error"));
    const failure = manager().listRepos("ns");
    await expect(failure).rejects.toBeInstanceOf(CloudflareRequestError);
    await expect(manager().listRepos("ns")).rejects.toThrow(/Authentication error/);
  });

  it("refuses a listing it cannot read", async () => {
    fetchMock.mockResolvedValue(envelope({ not: "an array" }));
    await expect(manager().listRepos("ns")).rejects.toThrow();
  });
});

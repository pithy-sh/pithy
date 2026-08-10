// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { describe, expect, it } from "vitest";
import { isDeployFailure, verifyDeployedVersion } from "./verifyDeploy";

/** A fetch double that answers each call from a script of `/health` bodies. `null` means the call throws. */
function health(script: (string | null | "notfound")[]): { fetchImpl: typeof fetch; calls: string[] } {
  const calls: string[] = [];
  let index = 0;
  const fetchImpl = (async (input: string | URL | Request) => {
    calls.push(String(input));
    const next = script[Math.min(index, script.length - 1)];
    index += 1;
    if (next === null) throw new TypeError("fetch failed");
    if (next === "notfound") return new Response("no", { status: 404 });
    return new Response(JSON.stringify({ status: "ok", version: next }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}

const NOW = { sleep: async () => undefined };

describe("verifyDeployedVersion", () => {
  it("verifies when the declared domain serves the version just shipped", async () => {
    const { fetchImpl, calls } = health(["v-new"]);
    const result = await verifyDeployedVersion({
      url: "https://api.example.com",
      expectedVersion: "v-new",
      fetchImpl,
      ...NOW,
    });

    expect(result.status).toBe("verified");
    expect(result.attempts).toBe(1);
    expect(calls[0]).toBe("https://api.example.com/health");
  });

  it("catches the failure a liveness probe cannot — the old version still answering", async () => {
    // The whole reason this is a version correlation and not a health check. A deploy that landed in
    // another account leaves the declared domain serving exactly what it served before, happily, at 200.
    const { fetchImpl } = health(["v-old"]);
    const result = await verifyDeployedVersion({
      url: "https://api.example.com",
      expectedVersion: "v-new",
      attempts: 3,
      fetchImpl,
      ...NOW,
    });

    expect(result.status).toBe("mismatch");
    expect(result.observed).toEqual(["v-old"]);
    expect(isDeployFailure(result.status)).toBe(true);
  });

  it("retries through propagation rather than failing the first miss", async () => {
    // A custom domain takes seconds to route to a new version. Concluding on attempt one would make the
    // check fire falsely on a perfectly good deploy, which trains everyone to ignore it.
    const { fetchImpl } = health([null, "v-old", "v-new"]);
    const result = await verifyDeployedVersion({
      url: "https://api.example.com",
      expectedVersion: "v-new",
      attempts: 5,
      fetchImpl,
      ...NOW,
    });

    expect(result.status).toBe("verified");
    expect(result.attempts).toBe(3);
  });

  it("reports a gradual deployment as inconclusive, never as a failure", async () => {
    // Under a gradual rollout the previous version is *legitimately* serving a share of traffic, so
    // hitting it is expected. Two distinct versions is the signal that the fleet is mixed.
    const { fetchImpl } = health(["v-old", "v-older", "v-old", "v-older", "v-old"]);
    const result = await verifyDeployedVersion({
      url: "https://api.example.com",
      expectedVersion: "v-new",
      attempts: 5,
      fetchImpl,
      ...NOW,
    });

    expect(result.status).toBe("inconclusive");
    expect(result.observed).toEqual(["v-old", "v-older"]);
    expect(isDeployFailure(result.status)).toBe(false);
    expect(result.detail).toContain("gradual deployment");
  });

  it("is inconclusive, not failed, when the Worker cannot report a version", async () => {
    // A project that has not adopted the CF_VERSION_METADATA binding genuinely cannot say. Failing the
    // deploy for that would punish an adopter for not having upgraded yet.
    const { fetchImpl } = health([undefined as unknown as string]);
    const result = await verifyDeployedVersion({
      url: "https://api.example.com",
      expectedVersion: "v-new",
      attempts: 2,
      fetchImpl,
      ...NOW,
    });

    expect(result.status).toBe("inconclusive");
    expect(result.detail).toContain("CF_VERSION_METADATA");
    expect(isDeployFailure(result.status)).toBe(false);
  });

  /**
   * #264. Nothing answering is not "cannot tell" — it is the deploy failing, and the address that did not
   * answer is the fact worth printing. The old sentence blamed `CF_VERSION_METADATA`, which sent an
   * adopter whose Worker was routed nowhere off to check a binding that was already there.
   */
  it("fails when nothing answers at all, naming the address rather than a binding", async () => {
    const { fetchImpl } = health([null]);
    const result = await verifyDeployedVersion({
      url: "https://api.example.com",
      expectedVersion: "v-new",
      attempts: 2,
      fetchImpl,
      ...NOW,
    });
    expect(result.status).toBe("unreachable");
    expect(result.detail).toContain("https://api.example.com");
    expect(result.detail).not.toContain("CF_VERSION_METADATA");
    expect(isDeployFailure(result.status)).toBe(true);
  });

  /** Answered with something this cannot read is a different fact from nothing answering. */
  it("ignores a non-200 body, and a Worker that answered is reachable", async () => {
    const { fetchImpl } = health(["notfound"]);
    const result = await verifyDeployedVersion({
      url: "https://api.example.com",
      expectedVersion: "v-new",
      attempts: 2,
      fetchImpl,
      ...NOW,
    });
    expect(result.status).toBe("inconclusive");
    expect(result.observed).toEqual([]);
    expect(isDeployFailure(result.status)).toBe(false);
  });

  it("does not double the slash on a url with a trailing one", async () => {
    const { fetchImpl, calls } = health(["v-new"]);
    await verifyDeployedVersion({
      url: "https://api.example.com/",
      expectedVersion: "v-new",
      fetchImpl,
      ...NOW,
    });
    expect(calls[0]).toBe("https://api.example.com/health");
  });
});

describe("isDeployFailure", () => {
  it("fails on a consistent mismatch and on nothing answering", () => {
    expect(isDeployFailure("mismatch")).toBe(true);
    // A Worker reachable at no address is a failed deploy, not a check that could not decide (#264).
    expect(isDeployFailure("unreachable")).toBe(true);
    expect(isDeployFailure("verified")).toBe(false);
    // Still ordinary: a gradual rollout, and a Worker that answered but cannot report its version.
    // Failing a deploy for either would train everyone to ignore the check.
    expect(isDeployFailure("inconclusive")).toBe(false);
  });
});

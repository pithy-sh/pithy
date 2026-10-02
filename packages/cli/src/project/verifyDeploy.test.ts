// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { describe, expect, it } from "vitest";
import { backoffSchedule, isDeployFailure, verifyDeployedVersion } from "./verifyDeploy";

/** A fetch double that answers each call from a script of `/health` bodies. `null` means the call throws. */
function health(script: (string | null | "notfound" | "noversion")[]): { fetchImpl: typeof fetch; calls: string[] } {
  const calls: string[] = [];
  let index = 0;
  const fetchImpl = (async (input: string | URL | Request) => {
    calls.push(String(input));
    const next = script[Math.min(index, script.length - 1)];
    index += 1;
    if (next === null) throw new TypeError("fetch failed");
    if (next === "notfound") return new Response("no", { status: 404 });
    // A 2xx that names no version: the route is mounted, `CF_VERSION_METADATA` is not. Distinct from a
    // 404, and the distinction is what `SETTLED_ATTEMPTS` turns on.
    if (next === "noversion")
      return new Response(JSON.stringify({ status: "ok" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    return new Response(JSON.stringify({ status: "ok", version: next }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}

const NOW = { sleep: async () => undefined };

/**
 * Records what the probe waited for, so the schedule is asserted rather than inferred from elapsed time.
 *
 * `NOW` above discards the duration, which is what every test wanting a fast run needs and is also why
 * the flat one-second delay survived a header claiming a backoff: nothing observed it.
 */
function recorder(): { sleep: (ms: number) => Promise<void>; waits: number[] } {
  const waits: number[] = [];
  return {
    sleep: async (ms: number) => {
      waits.push(ms);
    },
    waits,
  };
}

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

  /**
   * The defect in #677. The window was five attempts a constant second apart, so it concluded four
   * seconds after the upload and failed two consecutive correct deploys of the dashboard — each time
   * naming the version the previous deploy had shipped, which had since propagated and was serving.
   */
  it("waits on a doubling schedule by default, giving a new version about a minute", async () => {
    const { fetchImpl, calls } = health(["v-old"]);
    const clock = recorder();
    await verifyDeployedVersion({
      url: "https://api.example.com",
      expectedVersion: "v-new",
      fetchImpl,
      sleep: clock.sleep,
    });

    expect(calls).toHaveLength(7);
    expect(clock.waits).toEqual([1000, 2000, 4000, 8000, 16000, 32000]);
    // Roughly a minute, and deliberately clear of the (4s, 33s] interval real promotion was measured in.
    expect(clock.waits.reduce((a, b) => a + b, 0)).toBe(63_000);
  });

  it("costs a deploy that is already live one request and no wait at all", async () => {
    // The whole reason a wider window is free: the loop returns on the first sighting, so only a deploy
    // that has not propagated pays, and today it pays with a failed pipeline instead of a few seconds.
    const { fetchImpl, calls } = health(["v-new"]);
    const clock = recorder();
    const result = await verifyDeployedVersion({
      url: "https://api.example.com",
      expectedVersion: "v-new",
      fetchImpl,
      sleep: clock.sleep,
    });

    expect(result.status).toBe("verified");
    expect(calls).toHaveLength(1);
    expect(clock.waits).toEqual([]);
  });

  it("verifies on the last attempt rather than concluding before it", async () => {
    const { fetchImpl } = health(["v-old", "v-old", "v-old", "v-old", "v-old", "v-old", "v-new"]);
    const result = await verifyDeployedVersion({
      url: "https://api.example.com",
      expectedVersion: "v-new",
      fetchImpl,
      ...NOW,
    });

    expect(result.status).toBe("verified");
    expect(result.attempts).toBe(7);
  });

  it("still fails a consistent mismatch, now after the full minute", async () => {
    // A wider window must not soften the verdict. #264's two outcomes keep their meaning.
    const { fetchImpl, calls } = health(["v-old"]);
    const result = await verifyDeployedVersion({
      url: "https://api.example.com",
      expectedVersion: "v-new",
      fetchImpl,
      ...NOW,
    });

    expect(result.status).toBe("mismatch");
    expect(calls).toHaveLength(7);
    expect(isDeployFailure(result.status)).toBe(true);
  });

  it("still fails when nothing answers across the whole window", async () => {
    const { fetchImpl, calls } = health([null]);
    const result = await verifyDeployedVersion({
      url: "https://api.example.com",
      expectedVersion: "v-new",
      fetchImpl,
      ...NOW,
    });

    expect(result.status).toBe("unreachable");
    expect(calls).toHaveLength(7);
    expect(result.detail).toContain("https://api.example.com");
    expect(isDeployFailure(result.status)).toBe(true);
  });

  /**
   * Found by review on #677's own branch. The expected-version return fires on one condition, so widening
   * the window widened it for a verdict that is *ordinary* — a project with no `CF_VERSION_METADATA` would
   * pay 63s per Worker on every successful deploy, up from four. The kit's own first adopter was in that
   * state on both deployed environments.
   */
  it("stops after three 2xx answers that name no version, rather than waiting out the minute", async () => {
    const { fetchImpl, calls } = health(["noversion"]);
    const clock = recorder();
    const result = await verifyDeployedVersion({
      url: "https://api.example.com",
      expectedVersion: "v-new",
      fetchImpl,
      sleep: clock.sleep,
    });

    expect(result.status).toBe("inconclusive");
    expect(result.attempts).toBe(3);
    expect(calls).toHaveLength(3);
    // Three seconds, which is about the window this case had before #677 widened it.
    expect(clock.waits).toEqual([1000, 2000]);
    expect(result.detail).toContain("CF_VERSION_METADATA");
    expect(isDeployFailure(result.status)).toBe(false);
  });

  it("does not treat a non-2xx as settled, because a Worker still coming up is what the window is for", async () => {
    // The mistake available here: `version: null` covers both a 200-without-version and a 404, and
    // bailing on it would cut the window for a Worker that had simply not finished answering.
    const { fetchImpl, calls } = health(["notfound"]);
    const result = await verifyDeployedVersion({
      url: "https://api.example.com",
      expectedVersion: "v-new",
      fetchImpl,
      ...NOW,
    });

    expect(result.status).toBe("inconclusive");
    expect(calls).toHaveLength(7);
  });

  it("gives a Worker that answers versionless and then reports the whole window", async () => {
    // `settled === attempt` and not a streak: one version sighting means propagation is under way, so the
    // full schedule applies again even though the first answers named nothing.
    const { fetchImpl, calls } = health([
      "noversion",
      "v-old",
      "noversion",
      "noversion",
      "noversion",
      "noversion",
      "v-new",
    ]);
    const result = await verifyDeployedVersion({
      url: "https://api.example.com",
      expectedVersion: "v-new",
      fetchImpl,
      ...NOW,
    });

    expect(result.status).toBe("verified");
    expect(result.attempts).toBe(7);
    expect(calls).toHaveLength(7);
  });

  it("verifies before the settled exit can fire when the version arrives early", async () => {
    const { fetchImpl } = health(["noversion", "noversion", "v-new"]);
    const result = await verifyDeployedVersion({
      url: "https://api.example.com",
      expectedVersion: "v-new",
      fetchImpl,
      ...NOW,
    });

    expect(result.status).toBe("verified");
    expect(result.attempts).toBe(3);
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

describe("backoffSchedule", () => {
  it("doubles each wait, so the window widens without more attempts", () => {
    // Five sleeps bought four seconds when they were constant. The same five buy thirty-one doubling,
    // and the sixth buys the rest of the minute.
    expect(backoffSchedule(7, 1000)).toEqual([1000, 2000, 4000, 8000, 16000, 32000]);
  });

  it("has one fewer wait than attempts, because nothing is waited after the last probe", () => {
    expect(backoffSchedule(1, 1000)).toEqual([]);
    expect(backoffSchedule(2, 1000)).toEqual([1000]);
    expect(backoffSchedule(3, 250)).toEqual([250, 500]);
  });

  it("caps a single wait, so raising attempts stops scaling the total exponentially", () => {
    // `attempts` is a public option and its docstring invites tuning. Linear, 7 to 12 bought five more
    // seconds; uncapped doubling would make the same edit buy about thirty-four minutes, and `timeoutMs`
    // bounds one probe rather than the series.
    expect(backoffSchedule(12, 1000)).toEqual([
      1000, 2000, 4000, 8000, 16000, 32000, 32000, 32000, 32000, 32000, 32000,
    ]);
  });

  it("leaves the default schedule untouched, because its largest wait is exactly the cap", () => {
    expect(backoffSchedule(7, 1000)).toEqual([1000, 2000, 4000, 8000, 16000, 32000]);
    expect(Math.max(...backoffSchedule(7, 1000))).toBe(32_000);
  });

  it("is a schedule and not a clock, so a caller's own delay still doubles", () => {
    // `delayMs` stays injected: the suite drives it, and so may anyone who measures a different ceiling.
    expect(backoffSchedule(4, 10)).toEqual([10, 20, 40]);
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

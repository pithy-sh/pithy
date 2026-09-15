// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import type { Capability } from "@pithy-sh/core/src/capability/capability";
import { controlplane } from "@pithy-sh/core/src/controlPlane/capability";
import { PithyError } from "@pithy-sh/core/src/error/pithyError";
import { describe, expect, test } from "vitest";
import type { WorkerConfig } from "../project/config";
import { composedForGrant, resolveConnectScopes, resolveConnectTarget } from "./resolveTarget";

/** A capability that declares nothing but an admin surface — enough for a grant to be derived from it. */
const support: Capability = {
  name: "support",
  requiredBindings: [],
  adminRoutes: [
    { method: "GET", path: "/support/tickets", scope: "support:tickets:read", summary: "Page the queue." },
    { method: "POST", path: "/support/tickets/:id/close", scope: "support:tickets:close", summary: "Close one." },
  ],
};

/** One Worker, composing the seam and one capability, and declaring no address anywhere. */
function addressless(capabilities: Capability[]): {
  projectDir: string;
  environment: string;
  discoverWorkers: () => Promise<{ name: string; dir: string }[]>;
  loadConfig: () => Promise<WorkerConfig>;
} {
  return {
    projectDir: "/project",
    environment: "prod",
    discoverWorkers: async () => [{ name: "api", dir: "/project/apps/api" }],
    loadConfig: async () => ({ capabilities }) as WorkerConfig,
  };
}

/**
 * The same project, optionally declaring an address, with a tally of how often it was read.
 *
 * Whether the project is read at all is the whole question below, so the count is the assertion.
 */
function watched(
  capabilities: Capability[],
  hostname?: string,
): {
  options: {
    projectDir: string;
    environment: string;
    discoverWorkers: () => Promise<{ name: string; dir: string }[]>;
    loadConfig: () => Promise<WorkerConfig>;
  };
  reads: () => number;
} {
  let reads = 0;
  return {
    reads: () => reads,
    options: {
      ...addressless(capabilities),
      loadConfig: async () => {
        reads += 1;
        return {
          capabilities,
          ...(hostname === undefined ? {} : { domains: { prod: { pattern: hostname, zone: "example.com" } } }),
        } as WorkerConfig;
      },
    },
  };
}

/** The payload a call was expected to refuse with. Resolving is the failure, and says so. */
async function refusalOf(call: Promise<unknown>): Promise<PithyError["payload"]> {
  try {
    await call;
  } catch (thrown) {
    if (thrown instanceof PithyError) return thrown.payload;
    throw thrown;
  }
  throw new Error("the call resolved where a refusal was expected");
}

/**
 * **A grant is derived from what a Worker composes, and composing needs no address.**
 *
 * `--update --scope all` — widening an existing connection after composing a new capability, which is
 * the case `all` exists for — resolved no Worker at all, because the address resolution and the
 * composition resolution were one call. So `all` found nothing to grant and refused, on every project,
 * while the `pithy.config.ts` that answers the question sat unread beside it.
 *
 * The two are separated here rather than by making the address optional inside one resolver: an address
 * that is sometimes absent is a `ConnectTarget` whose `workerUrl` every caller has to re-check, and the
 * caller that forgets registers a connection pointing nowhere.
 */
describe("resolveConnectScopes", () => {
  test("reads what the Worker composes, with no address declared anywhere", async () => {
    const composed = await resolveConnectScopes(addressless([controlplane(), support]));

    expect(composed.map((capability) => capability.name)).toEqual(["controlplane", "support"]);
  });

  test("and the address resolver refuses that same project, which is why they are two calls", async () => {
    expect((await refusalOf(resolveConnectTarget(addressless([controlplane(), support])))).message).toContain(
      "no prod address",
    );
  });

  test("a Worker composing no seam is refused, rather than answering a grant for an unconnectable Worker", async () => {
    expect((await refusalOf(resolveConnectScopes(addressless([support])))).message).toContain(
      "does not compose the control-plane seam",
    );
  });
});

/**
 * **Which composed surface feeds the grant, and the one case that has to go and read it.**
 *
 * A resolved address already carries the composition, so it answers. Nothing else does — except
 * `--scope all`, which is derived from the composition and is asked for on exactly the path that
 * resolves no address: `--update --scope all`, widening an existing grant after composing a new
 * capability.
 *
 * **Stated here because it was a ternary in `connect`'s `run`, where nothing could execute it.** Deleting
 * that ternary reinstates the original defect in full — `--update --scope all` composes nothing and
 * refuses with `--scope all found nothing to grant.` on a project whose `pithy.config.ts` answers the
 * question — and the whole suite stayed green when it was deleted. It is one function now, and this is
 * the test that goes red.
 */
describe("composedForGrant", () => {
  test("a resolved target answers it, and the project is not read again to ask the same thing", async () => {
    const { options, reads } = watched([controlplane(), support], "api.example.com");
    const target = await resolveConnectTarget(options);
    const resolving = reads();

    const composed = await composedForGrant({ ...options, target, all: true });

    expect(composed.map((capability) => capability.name)).toEqual(["controlplane", "support"]);
    expect(reads()).toBe(resolving);
  });

  test("`--scope all` with no target reads the composition, on a project declaring no address at all", async () => {
    const { options, reads } = watched([controlplane(), support]);

    const composed = await composedForGrant({ ...options, target: null, all: true });

    expect(composed.map((capability) => capability.name)).toEqual(["controlplane", "support"]);
    expect(reads()).toBeGreaterThan(0);
  });

  // A key-only `--update`, and a named `--scope` on one: neither derives anything from the composition,
  // and reading it would demand a Worker that resolves and composes the seam for a rotation that needs
  // neither.
  test("no target and no `all` composes nothing, and reads nothing", async () => {
    const { options, reads } = watched([controlplane(), support]);

    expect(await composedForGrant({ ...options, target: null, all: false })).toEqual([]);
    expect(reads()).toBe(0);
  });

  // A grant read off nothing is the failure this whole path exists to avoid, so neither of these is
  // answered with an empty set that would fall through to `--scope all found nothing to grant.`
  test("a Worker composing no seam is refused here too, rather than composing an empty grant", async () => {
    const { options } = watched([support]);

    expect((await refusalOf(composedForGrant({ ...options, target: null, all: true }))).message).toContain(
      "does not compose the control-plane seam",
    );
  });

  test("a project that cannot be read at all is refused, in the loader's own words", async () => {
    const { options } = watched([controlplane()]);

    expect(
      (await refusalOf(composedForGrant({ ...options, discoverWorkers: async () => [], target: null, all: true })))
        .message,
    ).toContain("No pithy.config.ts here.");
  });
});

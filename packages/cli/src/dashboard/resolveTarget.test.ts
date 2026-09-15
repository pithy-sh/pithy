// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import type { Capability } from "@pithy-sh/core/src/capability/capability";
import { controlplane } from "@pithy-sh/core/src/controlPlane/capability";
import { PithyError } from "@pithy-sh/core/src/error/pithyError";
import { describe, expect, test } from "vitest";
import type { WorkerConfig } from "../project/config";
import { resolveConnectScopes, resolveConnectTarget } from "./resolveTarget";

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

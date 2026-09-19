// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Capability } from "@pithy-sh/core/src/capability/capability";
import { PithyError } from "@pithy-sh/core/src/error/pithyError";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { linkKitPackages, materializeKitPackage } from "../test-utils/linkKit";
import { hostEntryFile, hostEntrySource } from "./hostEntry";
import { hostWorkerFor, PAYMENTS_HOST_PEERS, TESTERS_HOST_PEERS } from "./hostRegistry";

/**
 * The generated entry a host that composes nothing is deployed from, when the project composes a peer it can
 * use (#645). What is pinned: which compositions get one, that it names the project's own install, and that
 * every other composition gets none — because a host deployed from its own `worker.ts` is one with no
 * specifier a bundler could fail on. `project/deployKit.test.ts` bundles the result with wrangler.
 */

let projectDir: string;

beforeEach(async () => {
  projectDir = await mkdtemp(join(tmpdir(), "pithy-host-entry-"));
  await linkKitPackages(projectDir, ["payments", "ledger", "testers", "auth"]);
});

afterEach(async () => {
  await rm(projectDir, { recursive: true, force: true });
});

/** A composed capability, carrying only what a peer rule reads. */
const composed = (name: string, extra: Record<string, unknown> = {}): Capability =>
  ({ name, requiredBindings: [], ...extra }) as Capability;

const CREDITING = composed("payments", {
  paymentsConfig: { products: { coins_100: { grants: { ledger: { currency: "coins", amount: 100 } } } } },
});
const FEATURES_ONLY = composed("payments", { paymentsConfig: { products: { pro: { entitlements: ["pro"] } } } });

const PAYMENTS = hostWorkerFor("payments");
const TESTERS = hostWorkerFor("testers");

describe("hostEntrySource", () => {
  test("the registry declares the two hosts that reach an optional peer, and those two only", () => {
    expect(PAYMENTS?.peers).toBe(PAYMENTS_HOST_PEERS);
    expect(TESTERS?.peers).toBe(TESTERS_HOST_PEERS);
    expect(
      ["email", "media", "secrets", "storage", "support", "vector"].map((name) => hostWorkerFor(name)?.peers),
    ).toEqual([undefined, undefined, undefined, undefined, undefined, undefined]);
  });

  test("a catalog that credits a balance hands the reconcile host the ledger from the project's install", () => {
    const source = hostEntrySource(projectDir, PAYMENTS as NonNullable<typeof PAYMENTS>, CREDITING, []);
    expect(source).toContain('import { ledgerPeer as peer0 } from "');
    expect(source).toContain("/ledger/src/peer.ts");
    expect(source).toContain("/payments/src/workflows/hostPeers.ts");
    expect(source).toContain('providePeers({ "ledger": peer0 });');
    // The host itself, re-exported whole: the Workflow class wrangler binds, and the cron handler.
    expect(source).toMatch(/export \* from ".*\/payments\/src\/workflows\/worker\.ts";/);
    expect(source).toMatch(/export \{ default \} from ".*\/payments\/src\/workflows\/worker\.ts";/);
  });

  test("a catalog that credits nothing gets no entry — the host deploys from its own worker", () => {
    expect(hostEntrySource(projectDir, PAYMENTS as NonNullable<typeof PAYMENTS>, FEATURES_ONLY, [])).toBeUndefined();
  });

  test("the testers host is handed auth when the project composes it, and nothing when it does not", () => {
    const testers = composed("testers");
    const withAuth = hostEntrySource(projectDir, TESTERS as NonNullable<typeof TESTERS>, testers, [
      composed("auth", { authConfig: {} }),
    ]);
    expect(withAuth).toContain('import { authPeer as peer0 } from "');
    expect(withAuth).toContain('providePeers({ "auth": peer0 });');
    expect(
      hostEntrySource(projectDir, TESTERS as NonNullable<typeof TESTERS>, testers, [composed("email")]),
    ).toBeUndefined();
    // An adopter's own capability named auth is not the kit's, and names no package to import.
    expect(
      hostEntrySource(projectDir, TESTERS as NonNullable<typeof TESTERS>, testers, [composed("auth")]),
    ).toBeUndefined();
  });

  test("a peer the project never installed is an actionable refusal at deploy, not a module error", async () => {
    const bare = await mkdtemp(join(tmpdir(), "pithy-host-entry-"));
    try {
      await linkKitPackages(bare, ["payments"]);
      expect(() => hostEntrySource(bare, PAYMENTS as NonNullable<typeof PAYMENTS>, CREDITING, [])).toThrow(PithyError);
    } finally {
      await rm(bare, { recursive: true, force: true });
    }
  });

  test("names one file per environment, beside the config that points at it", () => {
    expect(hostEntryFile("prod")).toBe(".pithy-host.prod.ts");
    expect(hostEntryFile("dev")).toBe(".pithy-host.dev.ts");
  });
});

/**
 * **A newer CLI meets older packages, and deploys them as it always did** (#645 review). The CLI and the packages
 * it deploys are released apart. The dashboard runs testers 0.2.9 beside auth, and the entry this PR first
 * generated imported `@pithy-sh/testers/src/workflows/hostPeers` — which 0.2.9 does not have — so its testers
 * host stopped deploying. An installed release is staged here by copying the workspace package and removing the
 * module the release predates, in both `src` and `dist`, since the project resolves through `dist`.
 */
describe("hostEntrySource against releases older than the seam", () => {
  /** Stage `name` as a release from before `module` existed. */
  async function predating(name: string, module: string): Promise<void> {
    await materializeKitPackage(projectDir, name);
    const home = join(projectDir, "node_modules", "@pithy-sh", name);
    await rm(join(home, "src", `${module}.ts`));
    await rm(join(home, "dist", `${module}.js`), { force: true });
    await rm(join(home, "dist", `${module}.d.ts`), { force: true });
  }

  test("a testers host from before the seam, beside auth, gets no entry and deploys from its own worker", async () => {
    await predating("testers", "workflows/hostPeers");
    const source = hostEntrySource(projectDir, TESTERS as NonNullable<typeof TESTERS>, composed("testers"), [
      composed("auth", { authConfig: {} }),
    ]);
    expect(source).toBeUndefined();
  });

  test("a payments host from before the seam gets no entry, whatever its catalog credits", async () => {
    await predating("payments", "workflows/hostPeers");
    expect(hostEntrySource(projectDir, PAYMENTS as NonNullable<typeof PAYMENTS>, CREDITING, [])).toBeUndefined();
  });

  test("a host that takes peers beside an auth too old to hand one over is refused by name", async () => {
    await predating("auth", "peer");
    let thrown: unknown;
    try {
      hostEntrySource(projectDir, TESTERS as NonNullable<typeof TESTERS>, composed("testers"), [
        composed("auth", { authConfig: {} }),
      ]);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(PithyError);
    const payload = (thrown as PithyError).payload;
    expect(payload.message).toBe(
      "The testers host reads auth, and the installed @pithy-sh/auth is too old to hand it over.",
    );
    expect(payload.action).toBe("Upgrade @pithy-sh/auth to the version @pithy-sh/testers peers, then deploy again.");
  });

  test("a crediting catalog beside a ledger too old to hand one over is refused by name", async () => {
    await predating("ledger", "peer");
    expect(() => hostEntrySource(projectDir, PAYMENTS as NonNullable<typeof PAYMENTS>, CREDITING, [])).toThrow(
      "The payments host reads ledger, and the installed @pithy-sh/ledger is too old to hand it over.",
    );
  });
});

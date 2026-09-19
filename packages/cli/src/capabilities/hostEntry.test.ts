// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Capability } from "@pithy-sh/core/src/capability/capability";
import { PithyError } from "@pithy-sh/core/src/error/pithyError";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { linkKitPackages } from "../test-utils/linkKit";
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
    const withAuth = hostEntrySource(projectDir, TESTERS as NonNullable<typeof TESTERS>, testers, [composed("auth")]);
    expect(withAuth).toContain('import { authPeer as peer0 } from "');
    expect(withAuth).toContain('providePeers({ "auth": peer0 });');
    expect(
      hostEntrySource(projectDir, TESTERS as NonNullable<typeof TESTERS>, testers, [composed("email")]),
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

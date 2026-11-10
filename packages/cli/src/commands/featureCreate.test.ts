// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { afterEach, describe, expect, test, vi } from "vitest";
import type { CreateReport } from "../feature/create";
import { runCaptured } from "../test-utils/payloadContract";

/**
 * **`pithy feature create` says that a worktree resolves packages from the main checkout, and how to check a
 * dependency change without it.** The worktree, the ports and the backend are stubbed by the report
 * `createFeature` returns, so what runs is the command's own body.
 */

const WORKTREE = "/home/you/acme/.worktrees/12-media-cli";

vi.mock("../feature/slugBudget", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../feature/slugBudget")>()),
  assertFeatureSlugFitsProject: async () => {},
}));
vi.mock("../feature/create", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../feature/create")>()),
  createFeature: async (): Promise<CreateReport> => ({
    command: "feature.create",
    branch: "feature/12-media-cli",
    worktree: WORKTREE,
    worktreeCreated: true,
    base: null,
    dev: {
      version: 1,
      branch: "feature/12-media-cli",
      ports: { index: 1, base: 8807, size: 20 },
      workers: {},
    },
  }),
}));
vi.mock("../feature/worktree", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../feature/worktree")>()),
  mainRepoRoot: async () => "/home/you/acme",
}));

afterEach(() => {
  vi.restoreAllMocks();
});

describe("pithy feature create", () => {
  test("warns that the worktree falls back to the checkout's node_modules, with the isolated check", async () => {
    const text = (await runCaptured("feature create", ["media-cli", "--issue", "12"])).join("");
    expect(text).toContain(
      "A package this worktree's node_modules lacks resolves from /home/you/acme/node_modules, so a dependency change can pass here and fail on a clean install. Verify one outside the checkout:\n",
    );
    expect(text).toContain(`  dir="$(mktemp -d)" && cp -R ${WORKTREE} "$dir" && cd "$dir/12-media-cli"\n`);
    expect(text).toContain("  npm ci\n");
    expect(text.indexOf("Verify one outside the checkout")).toBeLessThan(text.indexOf("Done."));
  });

  test("leaves the warning out of --json", async () => {
    const text = (await runCaptured("feature create", ["media-cli", "--issue", "12", "--json"])).join("");
    expect(text).not.toContain("node_modules");
  });
});

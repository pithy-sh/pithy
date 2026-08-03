// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { type CloudflareAccess, checkCloudflareAccess, describeCloudflareAccess } from "./cloudflare";

let dir: string;
const saved = { account: process.env.CLOUDFLARE_ACCOUNT_ID, token: process.env.CLOUDFLARE_API_TOKEN };

/**
 * Cut the network for a case where both credentials resolve. `checkCloudflareAccess` swallows the
 * failure into a state, which is the point: the split verdict is decided before any of it.
 */
const offline = (): void => {
  vi.stubGlobal("fetch", async () => {
    throw new Error("network disabled in unit tests");
  });
};

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "pithy-cf-doctor-"));
  // `loadCloudflareEnv` overlays process.env over the file, so a developer's own credentials would
  // otherwise leak into these assertions — and, worse, reach Cloudflare from a unit test.
  process.env.CLOUDFLARE_ACCOUNT_ID = undefined as unknown as string;
  process.env.CLOUDFLARE_API_TOKEN = undefined as unknown as string;
  delete process.env.CLOUDFLARE_ACCOUNT_ID;
  delete process.env.CLOUDFLARE_API_TOKEN;
});

afterEach(async () => {
  vi.unstubAllGlobals();
  await rm(dir, { recursive: true, force: true });
  if (saved.account === undefined) delete process.env.CLOUDFLARE_ACCOUNT_ID;
  else process.env.CLOUDFLARE_ACCOUNT_ID = saved.account;
  if (saved.token === undefined) delete process.env.CLOUDFLARE_API_TOKEN;
  else process.env.CLOUDFLARE_API_TOKEN = saved.token;
});

describe("checkCloudflareAccess", () => {
  test("no .dev.vars at all reports both keys missing, without reaching the network", async () => {
    expect(await checkCloudflareAccess(dir)).toEqual({
      state: "unconfigured",
      missing: ["CLOUDFLARE_ACCOUNT_ID", "CLOUDFLARE_API_TOKEN"],
      tokenStatus: null,
      credentialSplit: null,
    });
  });

  test("a half-configured file names only the key that is absent", async () => {
    await writeFile(join(dir, ".dev.vars"), "CLOUDFLARE_ACCOUNT_ID=abc123\n");
    expect(await checkCloudflareAccess(dir)).toEqual({
      state: "unconfigured",
      missing: ["CLOUDFLARE_API_TOKEN"],
      tokenStatus: null,
      credentialSplit: null,
    });
  });

  test("an empty value counts as missing, not as configured", async () => {
    await writeFile(join(dir, ".dev.vars"), "CLOUDFLARE_ACCOUNT_ID=abc123\nCLOUDFLARE_API_TOKEN=\n");
    expect((await checkCloudflareAccess(dir)).missing).toEqual(["CLOUDFLARE_API_TOKEN"]);
  });

  test("half the pair from the file and half from the environment is reported", async () => {
    // The fault this exists for: `loadCloudflareEnv` overlays per key, so a file that sets only the token
    // pairs it with whatever account id the shell happens to export. Nothing disagrees; the run just
    // authenticates as one account against another's id.
    await writeFile(join(dir, ".dev.vars"), "CLOUDFLARE_API_TOKEN=from-file\n");
    process.env.CLOUDFLARE_ACCOUNT_ID = "from-env";
    // Both keys now resolve, so the probe would call out — the stub keeps a unit test off Cloudflare.
    offline();
    expect((await checkCloudflareAccess(dir)).credentialSplit).toEqual({
      fromFile: ["CLOUDFLARE_API_TOKEN"],
      fromEnvironment: ["CLOUDFLARE_ACCOUNT_ID"],
    });
  });

  test("a complete file over a different account's exported pair is silent — the file decides the whole group", async () => {
    // The ordinary developer machine: this project's account in `.dev.vars`, an unrelated one in the shell.
    // The overlay applies to neither key, so nothing is mixed and there is nothing to say.
    await writeFile(join(dir, ".dev.vars"), "CLOUDFLARE_ACCOUNT_ID=mine\nCLOUDFLARE_API_TOKEN=mine-tok\n");
    process.env.CLOUDFLARE_ACCOUNT_ID = "other";
    process.env.CLOUDFLARE_API_TOKEN = "other-tok";
    offline();
    expect((await checkCloudflareAccess(dir)).credentialSplit).toBeNull();
  });
});

describe("describeCloudflareAccess", () => {
  const access = (over: Partial<CloudflareAccess>): CloudflareAccess => ({
    state: "ok",
    missing: [],
    tokenStatus: null,
    credentialSplit: null,
    ...over,
  });

  test("a reachable account reports the token's lifecycle status", () => {
    expect(describeCloudflareAccess(access({ state: "ok", tokenStatus: "active" }))).toBe("reachable (token active)");
  });

  test("unconfigured tells you which keys to set and where", () => {
    expect(describeCloudflareAccess(access({ state: "unconfigured", missing: ["CLOUDFLARE_API_TOKEN"] }))).toBe(
      "not configured (set CLOUDFLARE_API_TOKEN in .dev.vars)",
    );
  });

  test("a rejected token points at the credential rather than the account", () => {
    expect(describeCloudflareAccess(access({ state: "token_invalid" }))).toContain("CLOUDFLARE_API_TOKEN rejected");
  });

  test("an unreachable account distinguishes itself from a bad token", () => {
    const text = describeCloudflareAccess(access({ state: "account_unreachable", tokenStatus: "active" }));
    expect(text).toContain("token is valid");
    expect(text).toContain("CLOUDFLARE_ACCOUNT_ID");
  });

  test("a split credential group names which key came from where", () => {
    const text = describeCloudflareAccess(
      access({
        state: "ok",
        tokenStatus: "active",
        credentialSplit: { fromFile: ["CLOUDFLARE_API_TOKEN"], fromEnvironment: ["CLOUDFLARE_ACCOUNT_ID"] },
      }),
    );
    // Reachable is still true, and still said — the split is an extra warning, not a replacement.
    expect(text).toContain("reachable (token active)");
    expect(text).toContain(".dev.vars sets CLOUDFLARE_API_TOKEN");
    expect(text).toContain("the environment supplies CLOUDFLARE_ACCOUNT_ID");
  });
});

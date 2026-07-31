// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { type CloudflareAccess, checkCloudflareAccess, describeCloudflareAccess } from "./cloudflare";

let dir: string;
const saved = { account: process.env.CLOUDFLARE_ACCOUNT_ID, token: process.env.CLOUDFLARE_API_TOKEN };

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
    });
  });

  test("a half-configured file names only the key that is absent", async () => {
    await writeFile(join(dir, ".dev.vars"), "CLOUDFLARE_ACCOUNT_ID=abc123\n");
    expect(await checkCloudflareAccess(dir)).toEqual({
      state: "unconfigured",
      missing: ["CLOUDFLARE_API_TOKEN"],
      tokenStatus: null,
    });
  });

  test("an empty value counts as missing, not as configured", async () => {
    await writeFile(join(dir, ".dev.vars"), "CLOUDFLARE_ACCOUNT_ID=abc123\nCLOUDFLARE_API_TOKEN=\n");
    expect((await checkCloudflareAccess(dir)).missing).toEqual(["CLOUDFLARE_API_TOKEN"]);
  });
});

describe("describeCloudflareAccess", () => {
  const access = (over: Partial<CloudflareAccess>): CloudflareAccess => ({
    state: "ok",
    missing: [],
    tokenStatus: null,
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
});

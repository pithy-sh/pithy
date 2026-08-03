// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import { cloudflareCredentialSplit, loadCloudflareEnv, parseDevVars } from "./devVars";

describe("parseDevVars", () => {
  test("parses KEY=value lines, skipping comments and blanks", () => {
    const content = [
      "# a comment",
      "",
      "CLOUDFLARE_ACCOUNT_ID=acct-1",
      "  CLOUDFLARE_API_TOKEN = tok-2 ",
      "BAD LINE",
    ].join("\n");
    expect(parseDevVars(content)).toEqual({ CLOUDFLARE_ACCOUNT_ID: "acct-1", CLOUDFLARE_API_TOKEN: "tok-2" });
  });

  test("strips one layer of surrounding quotes and keeps `=` inside values", () => {
    expect(parseDevVars(`SECRETS_STORE_ID="store=abc"`)).toEqual({ SECRETS_STORE_ID: "store=abc" });
  });
});

describe("loadCloudflareEnv", () => {
  afterEach(() => vi.unstubAllEnvs());

  test("falls back to process.env for CF keys when no .dev.vars file is present", () => {
    vi.stubEnv("CLOUDFLARE_ACCOUNT_ID", "from-env-acct");
    vi.stubEnv("CLOUDFLARE_API_TOKEN", "from-env-token");
    vi.stubEnv("SECRETS_STORE_ID", "from-env-store");
    vi.stubEnv("R2_CREDENTIALS", ""); // unset for this case — empty is skipped, not overlaid

    // A directory with no .dev.vars — the read fails and the env overlay supplies the creds.
    const vars = loadCloudflareEnv("/nonexistent-pithy-dir");
    expect(vars).toEqual({
      CLOUDFLARE_ACCOUNT_ID: "from-env-acct",
      CLOUDFLARE_API_TOKEN: "from-env-token",
      SECRETS_STORE_ID: "from-env-store",
    });
  });

  test("overlays R2_CREDENTIALS from process.env so CI can pass R2 keys without a .dev.vars file", () => {
    vi.stubEnv("CLOUDFLARE_ACCOUNT_ID", "from-env-acct");
    vi.stubEnv("CLOUDFLARE_API_TOKEN", "from-env-token");
    vi.stubEnv("R2_CREDENTIALS", '{"accessKeyId":"ak","secretAccessKey":"sk"}');

    const vars = loadCloudflareEnv("/nonexistent-pithy-dir");
    expect(vars.R2_CREDENTIALS).toBe('{"accessKeyId":"ak","secretAccessKey":"sk"}');
  });
});

describe("cloudflareCredentialSplit", () => {
  let dir: string;

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    vi.unstubAllEnvs();
  });

  /** Write a `.dev.vars` into a fresh temp dir and return it. */
  const withDevVars = (body: string): string => {
    dir = mkdtempSync(join(tmpdir(), "pithy-devvars-"));
    writeFileSync(join(dir, ".dev.vars"), body);
    return dir;
  };

  test("a file with only the token, over an ambient account id, is a split", () => {
    const target = withDevVars("CLOUDFLARE_API_TOKEN=tok\n");
    expect(cloudflareCredentialSplit(target, { CLOUDFLARE_ACCOUNT_ID: "from-env" })).toEqual({
      fromFile: ["CLOUDFLARE_API_TOKEN"],
      fromEnvironment: ["CLOUDFLARE_ACCOUNT_ID"],
    });
  });

  test("a file with only the account id, over an ambient token, is the same split the other way round", () => {
    const target = withDevVars("CLOUDFLARE_ACCOUNT_ID=acct\n");
    expect(cloudflareCredentialSplit(target, { CLOUDFLARE_API_TOKEN: "from-env" })).toEqual({
      fromFile: ["CLOUDFLARE_ACCOUNT_ID"],
      fromEnvironment: ["CLOUDFLARE_API_TOKEN"],
    });
  });

  test("a complete file is silent, even when the environment holds a different account's pair", () => {
    // The ordinary developer machine: one coherent pair in the project, another coherent pair exported
    // for an unrelated account. The file wins for every key in the group, so nothing is mixed.
    const target = withDevVars("CLOUDFLARE_ACCOUNT_ID=mine\nCLOUDFLARE_API_TOKEN=mine-tok\n");
    expect(
      cloudflareCredentialSplit(target, { CLOUDFLARE_ACCOUNT_ID: "other", CLOUDFLARE_API_TOKEN: "other-tok" }),
    ).toBeNull();
  });

  test("no .dev.vars at all is silent — CI passes the whole pair as environment variables", () => {
    dir = mkdtempSync(join(tmpdir(), "pithy-devvars-"));
    expect(cloudflareCredentialSplit(dir, { CLOUDFLARE_ACCOUNT_ID: "acct", CLOUDFLARE_API_TOKEN: "tok" })).toBeNull();
  });

  test("half a file with nothing in the environment is silent — that is unconfigured, not a split", () => {
    const target = withDevVars("CLOUDFLARE_API_TOKEN=tok\n");
    expect(cloudflareCredentialSplit(target, {})).toBeNull();
  });

  test("an empty value in the file counts as unset, exactly as the overlay treats it", () => {
    const target = withDevVars("CLOUDFLARE_ACCOUNT_ID=\nCLOUDFLARE_API_TOKEN=tok\n");
    expect(cloudflareCredentialSplit(target, { CLOUDFLARE_ACCOUNT_ID: "from-env" })).toEqual({
      fromFile: ["CLOUDFLARE_API_TOKEN"],
      fromEnvironment: ["CLOUDFLARE_ACCOUNT_ID"],
    });
  });

  test("the group is the account pair alone — a store id or R2 keys from elsewhere are not a split", () => {
    const target = withDevVars("CLOUDFLARE_ACCOUNT_ID=acct\nCLOUDFLARE_API_TOKEN=tok\n");
    expect(
      cloudflareCredentialSplit(target, { SECRETS_STORE_ID: "store", R2_CREDENTIALS: '{"accessKeyId":"ak"}' }),
    ).toBeNull();
  });

  test("defaults to the ambient process.env, so a caller need not thread it", () => {
    const target = withDevVars("CLOUDFLARE_API_TOKEN=tok\n");
    vi.stubEnv("CLOUDFLARE_ACCOUNT_ID", "from-env");
    expect(cloudflareCredentialSplit(target)).toEqual({
      fromFile: ["CLOUDFLARE_API_TOKEN"],
      fromEnvironment: ["CLOUDFLARE_ACCOUNT_ID"],
    });
  });
});

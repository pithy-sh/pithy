// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PithyError } from "@pithy-sh/core/src/error/pithyError";
import { describe, expect, test } from "vitest";
import { cloudflareChildEnv, overriddenCredentialKeys } from "./childEnv";

/** A throwaway config directory, optionally holding a `cloudflare.json`, so a case states its own file. */
function configDir(contents?: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "pithy-child-env-"));
  if (contents) writeFileSync(join(dir, "cloudflare.json"), JSON.stringify(contents), { mode: 0o600 });
  return dir;
}

/** The child's inherited environment, pointed at a throwaway config directory the way `process.env` is. */
function base(dir: string, rest: Record<string, string> = {}): NodeJS.ProcessEnv {
  return { PITHY_CONFIG_DIR: dir, ...rest };
}

describe("cloudflareChildEnv", () => {
  test("the project's credentials beat the shell's — the whole of #555 in one assertion", () => {
    const dir = configDir({ CLOUDFLARE_ACCOUNT_ID: "project-account", CLOUDFLARE_API_TOKEN: "project-token" });
    const env = cloudflareChildEnv({
      account: null,
      base: base(dir, {
        PATH: "/usr/bin",
        CLOUDFLARE_ACCOUNT_ID: "shell-account",
        CLOUDFLARE_API_TOKEN: "shell-token",
      }),
    });
    expect(env.CLOUDFLARE_ACCOUNT_ID).toBe("project-account");
    expect(env.CLOUDFLARE_API_TOKEN).toBe("project-token");
    // Everything else the child would have inherited is still there: this replaces two keys, not an
    // environment. A child that lost its PATH would not find wrangler at all.
    expect(env.PATH).toBe("/usr/bin");
  });

  test("returns the child's whole environment, not a fragment to merge", () => {
    // The seam hands back something a caller can spawn with directly. #555 was a forgotten merge, and a
    // function that returns an overlay is a function whose merge can be forgotten again.
    const dir = configDir({ CLOUDFLARE_ACCOUNT_ID: "a", CLOUDFLARE_API_TOKEN: "t" });
    const env = cloudflareChildEnv({ account: null, base: base(dir, { HOME: "/home/dev" }) });
    expect(env.HOME).toBe("/home/dev");
  });

  test("with no credentials file the shell's pair stands — the overwrite corrects, it never blanks", () => {
    // `resolveCloudflare` already falls back to the environment per key, so on a machine that has never
    // run `pithy init` the resolved pair *is* the shell's pair and the child is unchanged.
    const env = cloudflareChildEnv({
      account: null,
      base: base(configDir(), { CLOUDFLARE_ACCOUNT_ID: "shell-account", CLOUDFLARE_API_TOKEN: "shell-token" }),
    });
    expect(env.CLOUDFLARE_ACCOUNT_ID).toBe("shell-account");
    expect(env.CLOUDFLARE_API_TOKEN).toBe("shell-token");
  });

  test("offline blanks the pair rather than passing the shell's through", () => {
    // Under PITHY_OFFLINE the resolution refuses the ambient pair, and a child that still carried it
    // would authenticate as the account the whole switch exists to keep out of the run (#218).
    const env = cloudflareChildEnv({
      account: null,
      base: base(configDir(), {
        PATH: "/usr/bin",
        CLOUDFLARE_ACCOUNT_ID: "shell-account",
        CLOUDFLARE_API_TOKEN: "shell-token",
      }),
      offline: true,
    });
    expect(env.CLOUDFLARE_ACCOUNT_ID).toBeUndefined();
    expect(env.CLOUDFLARE_API_TOKEN).toBeUndefined();
    expect(env.PATH).toBe("/usr/bin");
  });

  test("`account: null` reads the DEFAULT file — which is why it must never stand in for `unknown`", () => {
    // The hazard behind a bug this change briefly shipped. `null` means *this project names no account*,
    // so it resolves `cloudflare.json`. A caller that flattens "I could not resolve a pair" to `null`
    // therefore does not fall back to nothing — it falls back to the default file, which on a
    // two-account machine is another tenant's live token, with the pin that would have refused it gone.
    // `HostDeployOptions.account` carries the selection for exactly this reason.
    const dir = mkdtempSync(join(tmpdir(), "pithy-child-env-"));
    writeFileSync(join(dir, "cloudflare.json"), JSON.stringify({ CLOUDFLARE_API_TOKEN: "default-file-token" }), {
      mode: 0o600,
    });
    writeFileSync(join(dir, "cloudflare.acme.json"), JSON.stringify({ CLOUDFLARE_API_TOKEN: "named-file-token" }), {
      mode: 0o600,
    });
    expect(cloudflareChildEnv({ account: null, base: base(dir) }).CLOUDFLARE_API_TOKEN).toBe("default-file-token");
    // The named selection is the one that reaches the project's own file.
    expect(cloudflareChildEnv({ account: { accountName: "acme" }, base: base(dir) }).CLOUDFLARE_API_TOKEN).toBe(
      "named-file-token",
    );
  });

  test("a pin the credentials contradict refuses before the child is ever spawned", () => {
    // #206's refusal, inherited by every spawn site that builds its environment here. `pithy deploy`
    // has had it since #206; `pithy dev` never resolved an account, so it had nothing to compare.
    const dir = configDir({ CLOUDFLARE_ACCOUNT_ID: "other-account", CLOUDFLARE_API_TOKEN: "t" });
    let caught: unknown = null;
    try {
      cloudflareChildEnv({ account: { accountId: "pinned-account" }, base: base(dir) });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(PithyError);
    expect((caught as PithyError).payload.message).toContain("pinned-account");
    expect((caught as PithyError).payload.message).toContain("other-account");
  });
});

describe("overriddenCredentialKeys", () => {
  test("names the keys the project replaced, so a startup line can say wrangler whoami will disagree", () => {
    const shell = { CLOUDFLARE_ACCOUNT_ID: "shell-account", CLOUDFLARE_API_TOKEN: "shell-token" };
    const child = { CLOUDFLARE_ACCOUNT_ID: "project-account", CLOUDFLARE_API_TOKEN: "project-token" };
    expect(overriddenCredentialKeys(shell, child)).toEqual(["CLOUDFLARE_ACCOUNT_ID", "CLOUDFLARE_API_TOKEN"]);
  });

  test("says nothing when the shell exported nothing to override", () => {
    const child = { CLOUDFLARE_ACCOUNT_ID: "project-account", CLOUDFLARE_API_TOKEN: "project-token" };
    expect(overriddenCredentialKeys({ PATH: "/usr/bin" }, child)).toEqual([]);
  });

  test("says nothing when the shell's value is the one that resolved", () => {
    // The overlay filled the key from the environment: nothing was replaced, so there is nothing to
    // report. A line here would fire on every CI run, where the environment is the intended source.
    expect(
      overriddenCredentialKeys({ CLOUDFLARE_API_TOKEN: "shell-token" }, { CLOUDFLARE_API_TOKEN: "shell-token" }),
    ).toEqual([]);
  });

  test("counts a key the resolution dropped — offline blanks it, and the child no longer carries it", () => {
    expect(overriddenCredentialKeys({ CLOUDFLARE_API_TOKEN: "shell-token" }, {})).toEqual(["CLOUDFLARE_API_TOKEN"]);
  });

  test("ignores everything that is not a credential — a changed PATH is not an account fact", () => {
    expect(overriddenCredentialKeys({ PATH: "/a" }, { PATH: "/b" })).toEqual([]);
  });
});

// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { CloudflareConfigOptions } from "../cloudflare/config";
import { type CloudflareAccess, checkCloudflareAccess, describeCloudflareAccess } from "./cloudflare";

let dir: string;

/**
 * The account config directory these tests resolve against. `PITHY_CONFIG_DIR` is the one variable that
 * relocates everything Pithy keeps per machine, so pointing it at a temp directory is what keeps a unit
 * test off the operator's real `cloudflare.json` — the file that holds their live API token.
 */
function paths(env: Record<string, string> = {}): CloudflareConfigOptions {
  return { env: { PITHY_CONFIG_DIR: dir, ...env }, account: null };
}

/** Write the account's `cloudflare.json` for this run. */
async function config(values: Record<string, string>): Promise<void> {
  await writeFile(join(dir, "cloudflare.json"), JSON.stringify(values, null, 2), { mode: 0o600 });
}

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
});

afterEach(async () => {
  vi.unstubAllGlobals();
  await rm(dir, { recursive: true, force: true });
});

describe("checkCloudflareAccess", () => {
  test("no cloudflare.json at all reports both keys missing, without reaching the network", async () => {
    expect(await checkCloudflareAccess(paths())).toEqual({
      state: "unconfigured",
      missing: ["CLOUDFLARE_ACCOUNT_ID", "CLOUDFLARE_API_TOKEN"],
      tokenStatus: null,
      credentialSplit: null,
      configPath: join(dir, "cloudflare.json"),
      accountName: null,
      accountMismatch: null,
      credentialSource: null,
    });
  });

  test("a half-configured file names only the key that is absent", async () => {
    await config({ CLOUDFLARE_ACCOUNT_ID: "abc123" });
    expect(await checkCloudflareAccess(paths())).toEqual({
      state: "unconfigured",
      missing: ["CLOUDFLARE_API_TOKEN"],
      tokenStatus: null,
      credentialSplit: null,
      configPath: join(dir, "cloudflare.json"),
      accountName: null,
      accountMismatch: null,
      credentialSource: "file",
    });
  });

  test("an empty value counts as missing, not as configured", async () => {
    await config({ CLOUDFLARE_ACCOUNT_ID: "abc123", CLOUDFLARE_API_TOKEN: "" });
    expect((await checkCloudflareAccess(paths())).missing).toEqual(["CLOUDFLARE_API_TOKEN"]);
  });

  test("half the pair from the file and half from the environment is reported", async () => {
    // The fault this exists for: `cloudflareEnv` overlays per key, so a file that sets only the token
    // pairs it with whatever account id the shell happens to export. Nothing disagrees; the run just
    // authenticates as one account against another's id.
    await config({ CLOUDFLARE_API_TOKEN: "from-file" });
    // Both keys now resolve, so the probe would call out — the stub keeps a unit test off Cloudflare.
    offline();
    expect((await checkCloudflareAccess(paths({ CLOUDFLARE_ACCOUNT_ID: "from-env" }))).credentialSplit).toEqual({
      fromFile: ["CLOUDFLARE_API_TOKEN"],
      fromEnvironment: ["CLOUDFLARE_ACCOUNT_ID"],
    });
  });

  test("a complete file over a different account's exported pair is silent — the file decides the whole group", async () => {
    // The ordinary developer machine: this account in `cloudflare.json`, an unrelated one in the shell.
    // The overlay applies to neither key, so nothing is mixed and there is nothing to say.
    await config({ CLOUDFLARE_ACCOUNT_ID: "mine", CLOUDFLARE_API_TOKEN: "mine-tok" });
    offline();
    const env = { CLOUDFLARE_ACCOUNT_ID: "other", CLOUDFLARE_API_TOKEN: "other-tok" };
    expect((await checkCloudflareAccess(paths(env))).credentialSplit).toBeNull();
  });

  test("the environment supplies the whole pair when there is no file — how CI runs", async () => {
    offline();
    const env = { CLOUDFLARE_ACCOUNT_ID: "ci-account", CLOUDFLARE_API_TOKEN: "ci-token" };
    const access = await checkCloudflareAccess(paths(env));
    expect(access.missing).toEqual([]);
    expect(access.credentialSplit).toBeNull();
  });
});

/**
 * The mode #218 exists for. The acceptance test is empirical — see the issue — but the unit is the same
 * claim in one assertion: nothing was asked of Cloudflare, and the report says so rather than guessing.
 */
describe("checkCloudflareAccess, offline", () => {
  test("reports not checked without touching the network, even with a pair exported", async () => {
    const reached = vi.fn(async () => {
      throw new Error("nothing may call Cloudflare when the caller has said not to");
    });
    vi.stubGlobal("fetch", reached);
    const env = { CLOUDFLARE_ACCOUNT_ID: "ambient", CLOUDFLARE_API_TOKEN: "ambient-token", PITHY_OFFLINE: "1" };
    const access = await checkCloudflareAccess(paths(env));
    expect(access.state).toBe("not_checked");
    expect(reached).not.toHaveBeenCalled();
    // The ambient pair is not merely unused — it never resolved, so nothing downstream could use it either.
    expect(access.missing).toEqual(["CLOUDFLARE_ACCOUNT_ID", "CLOUDFLARE_API_TOKEN"]);
    expect(access.credentialSource).toBeNull();
  });

  test("a complete file is still not probed — offline is about the wire, not about the credentials", async () => {
    await config({ CLOUDFLARE_ACCOUNT_ID: "acct", CLOUDFLARE_API_TOKEN: "tok" });
    const reached = vi.fn(async () => {
      throw new Error("offline means offline");
    });
    vi.stubGlobal("fetch", reached);
    const access = await checkCloudflareAccess(paths({ PITHY_OFFLINE: "1" }));
    expect(access.state).toBe("not_checked");
    expect(access.credentialSource).toBe("file");
    expect(reached).not.toHaveBeenCalled();
  });

  test("the option alone is enough, which is what --offline passes", async () => {
    const reached = vi.fn(async () => {
      throw new Error("offline means offline");
    });
    vi.stubGlobal("fetch", reached);
    const access = await checkCloudflareAccess({
      ...paths({ CLOUDFLARE_ACCOUNT_ID: "ambient", CLOUDFLARE_API_TOKEN: "ambient-token" }),
      offline: true,
    });
    expect(access.state).toBe("not_checked");
    expect(reached).not.toHaveBeenCalled();
  });

  test("a pin the file contradicts still wins, because that fault is established from files alone", async () => {
    await config({ CLOUDFLARE_ACCOUNT_ID: "someone-elses", CLOUDFLARE_API_TOKEN: "tok" });
    const access = await checkCloudflareAccess({
      ...paths({ PITHY_OFFLINE: "1" }),
      account: { accountId: "leed-acct" },
    });
    expect(access.state).toBe("account_mismatch");
  });
});

describe("checkCloudflareAccess, naming where the credentials came from", () => {
  test("an exported pair with no file is `environment` — the shape of the incident", async () => {
    offline();
    const access = await checkCloudflareAccess(paths({ CLOUDFLARE_ACCOUNT_ID: "ci", CLOUDFLARE_API_TOKEN: "tok" }));
    expect(access.credentialSource).toBe("environment");
  });

  test("a complete file is `file`", async () => {
    await config({ CLOUDFLARE_ACCOUNT_ID: "acct", CLOUDFLARE_API_TOKEN: "tok" });
    offline();
    expect((await checkCloudflareAccess(paths())).credentialSource).toBe("file");
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
      "not configured (set CLOUDFLARE_API_TOKEN in ~/.config/pithy/cloudflare.json, or the environment)",
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
    expect(text).toContain("cloudflare.json sets CLOUDFLARE_API_TOKEN");
    expect(text).toContain("the environment supplies CLOUDFLARE_ACCOUNT_ID");
  });
});

/**
 * "Which account am I about to deploy to" must never require inspection — the same argument #166's
 * `Secrets:` line was built on, and one level up from #182's split warning (#206).
 */
describe("checkCloudflareAccess, for a project that names its account", () => {
  test("names the file it resolved, on every run, whether or not there is one", async () => {
    expect((await checkCloudflareAccess(paths())).configPath).toBe(join(dir, "cloudflare.json"));
    const access = await checkCloudflareAccess({ ...paths(), account: { accountName: "leed" } });
    expect(access.configPath).toBe(join(dir, "cloudflare.leed.json"));
    expect(access.accountName).toBe("leed");
  });

  test("a pinned account the credentials do not match is its own state, and it fails the exit", async () => {
    await config({ CLOUDFLARE_ACCOUNT_ID: "someone-elses", CLOUDFLARE_API_TOKEN: "tok" });
    const access = await checkCloudflareAccess({ ...paths(), account: { accountId: "leed-acct" } });
    // Not "ok" and not "unconfigured", which is what `pithy doctor` turns into a non-zero exit.
    expect(access.state).toBe("account_mismatch");
    expect(access.accountMismatch).toMatchObject({ pinned: "leed-acct", resolved: "someone-elses", source: "file" });
  });

  test("the mismatch is decided before the network, so a wrong-account run never authenticates", async () => {
    await config({ CLOUDFLARE_ACCOUNT_ID: "someone-elses", CLOUDFLARE_API_TOKEN: "tok" });
    const reached = vi.fn(async () => {
      throw new Error("nothing may call Cloudflare with credentials the project does not claim");
    });
    vi.stubGlobal("fetch", reached);
    expect((await checkCloudflareAccess({ ...paths(), account: { accountId: "leed-acct" } })).state).toBe(
      "account_mismatch",
    );
    expect(reached).not.toHaveBeenCalled();
  });

  test("an overlaid account id is verified too — the CI job pointed at the wrong tenant", async () => {
    const access = await checkCloudflareAccess({
      ...paths({ CLOUDFLARE_ACCOUNT_ID: "wrong", CLOUDFLARE_API_TOKEN: "tok" }),
      account: { accountId: "leed-acct" },
    });
    expect(access.state).toBe("account_mismatch");
    expect(access.accountMismatch).toMatchObject({ source: "environment" });
  });

  test("a matching pin says nothing at all — the state is decided by reachability, as before", async () => {
    await config({ CLOUDFLARE_ACCOUNT_ID: "leed-acct", CLOUDFLARE_API_TOKEN: "tok" });
    offline();
    const access = await checkCloudflareAccess({ ...paths(), account: { accountId: "leed-acct" } });
    expect(access.accountMismatch).toBeNull();
    expect(access.state).not.toBe("account_mismatch");
  });

  test("CI with no file and no account name is unchanged", async () => {
    offline();
    const access = await checkCloudflareAccess(paths({ CLOUDFLARE_ACCOUNT_ID: "ci", CLOUDFLARE_API_TOKEN: "tok" }));
    expect(access.missing).toEqual([]);
    expect(access.accountName).toBeNull();
    expect(access.accountMismatch).toBeNull();
    expect(access.configPath).toBe(join(dir, "cloudflare.json"));
  });
});

describe("describeCloudflareAccess, for a resolved file", () => {
  test("names the file the credentials came from, so the account is never a matter of inspection", () => {
    const text = describeCloudflareAccess({
      state: "ok",
      missing: [],
      tokenStatus: "active",
      credentialSplit: null,
      configPath: "/home/u/.config/pithy/cloudflare.leed.json",
      accountName: "leed",
      accountMismatch: null,
    });
    expect(text).toContain("reachable (token active)");
    expect(text).toContain("/home/u/.config/pithy/cloudflare.leed.json");
  });

  test("a mismatch names both ids, which is the whole point of the pin", () => {
    const text = describeCloudflareAccess({
      state: "account_mismatch",
      missing: [],
      tokenStatus: null,
      credentialSplit: null,
      configPath: "/home/u/.config/pithy/cloudflare.leed.json",
      accountName: "leed",
      accountMismatch: {
        pinned: "leed-acct",
        resolved: "someone-elses",
        source: "file",
        path: "/home/u/.config/pithy/cloudflare.leed.json",
      },
    });
    expect(text).toContain("leed-acct");
    expect(text).toContain("someone-elses");
  });

  test("a stubbed probe that names no file prints exactly what it printed before", () => {
    expect(describeCloudflareAccess({ state: "ok", missing: [], tokenStatus: "active", credentialSplit: null })).toBe(
      "reachable (token active)",
    );
  });

  /**
   * The announcement half of #218. `; from <file>` was true of the resolution and false about the
   * credentials: in CI, and in the sandbox, that file does not exist and a token from the shell did the
   * authenticating. A diagnostic that names a file it did not read is the one thing it must not do.
   */
  test("an environment pair says so, and says which file it did not come from", () => {
    const text = describeCloudflareAccess(
      {
        state: "ok",
        missing: [],
        tokenStatus: "active",
        credentialSplit: null,
        configPath: "/home/u/.config/pithy/cloudflare.json",
        accountName: null,
        accountMismatch: null,
        credentialSource: "environment",
      },
      "/home/u",
    );
    expect(text).toBe(
      "reachable (token active); credentials from the environment, not ~/.config/pithy/cloudflare.json",
    );
  });

  test("a file pair keeps the sentence it has always had", () => {
    const text = describeCloudflareAccess(
      {
        state: "ok",
        missing: [],
        tokenStatus: "active",
        credentialSplit: null,
        configPath: "/home/u/.config/pithy/cloudflare.json",
        accountName: null,
        accountMismatch: null,
        credentialSource: "file",
      },
      "/home/u",
    );
    expect(text).toBe("reachable (token active); from ~/.config/pithy/cloudflare.json");
  });

  test("not checked names the mode, so nobody reads it as a pass or as a failure", () => {
    const text = describeCloudflareAccess(
      {
        state: "not_checked",
        missing: [],
        tokenStatus: null,
        credentialSplit: null,
        configPath: "/home/u/.config/pithy/cloudflare.json",
        accountName: null,
        accountMismatch: null,
        credentialSource: "file",
      },
      "/home/u",
    );
    expect(text).toBe(
      "not checked — offline (PITHY_OFFLINE or --offline); credentials would resolve from ~/.config/pithy/cloudflare.json",
    );
  });
});

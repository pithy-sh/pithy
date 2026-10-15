// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { CloudflareConfigOptions } from "../cloudflare/config";
import { bindProfile } from "../cloudflare/session/bindings";
import { writeSession } from "../cloudflare/session/store";
import { checkCloudflareAccess, describeCloudflareAccess } from "./cloudflare";

/**
 * **What `pithy doctor` says about a signed-in session (#759).** The clients are replaced, and each call is
 * counted, because the whole point of one case is which endpoint was *not* asked: `tokens/verify` answers
 * an OAuth access token with "Invalid API Token", so a session verified through it reads as broken.
 */
const calls = vi.hoisted(() => ({
  getUser: 0,
  accountVerify: 0,
  userVerify: 0,
  user: { email: "jim@pithy.sh" } as unknown,
  reachable: true,
}));

vi.mock("../cloudflare/clients", () => ({
  cloudflareClients: async () => ({
    user: () => ({
      getUser: async () => {
        calls.getUser += 1;
        if (calls.user === null) throw new Error("401");
        return calls.user;
      },
      verifyToken: async () => {
        calls.userVerify += 1;
        return { id: "t", status: "active" };
      },
    }),
    accountTokens: () => ({
      verifyToken: async () => {
        calls.accountVerify += 1;
        return { id: "t", status: "active" };
      },
      validateServiceAccess: async () => calls.reachable,
    }),
  }),
}));

let dir: string;
let project: string;
const NOW = () => new Date("2026-10-15T12:00:00.000Z");

function here(env: Record<string, string> = {}): CloudflareConfigOptions {
  return { env: { PITHY_CONFIG_DIR: dir, ...env }, account: null, cwd: project, now: NOW };
}

async function signedIn(expiresAt = "2026-10-15T13:00:00.000Z"): Promise<void> {
  await bindProfile(project, "pithy", { env: { PITHY_CONFIG_DIR: dir } });
  await writeSession(
    {
      profile: "pithy",
      accountId: "acct",
      accountName: "pithy.",
      email: "jim@pithy.sh",
      accessToken: "opaque-access-token",
      refreshToken: "RT",
      expiresAt,
      scope: "user-details.read",
    },
    { env: { PITHY_CONFIG_DIR: dir } },
  );
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "pithy-cf-doctor-session-"));
  project = join(dir, "project");
  await mkdir(project);
  calls.getUser = 0;
  calls.accountVerify = 0;
  calls.userVerify = 0;
  calls.user = { email: "jim@pithy.sh" };
  calls.reachable = true;
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("pithy doctor, under a signed-in session", () => {
  test("verifies the session as the person it names, never through tokens/verify, and says who and which profile", async () => {
    await signedIn();
    const access = await checkCloudflareAccess(here());
    expect(access.state).toBe("ok");
    expect(access.credentialKind).toBe("session");
    expect(calls.getUser).toBe(1);
    expect(calls.accountVerify + calls.userVerify).toBe(0);
    expect(describeCloudflareAccess(access)).toMatch(/signed in as jim@pithy\.sh, profile pithy/);
    expect(describeCloudflareAccess(access)).toMatch(/from the session in .*session\.pithy\.json/);
  });

  test("a session Cloudflare rejects is reported with the sign-in, not as a bad API token", async () => {
    await signedIn();
    calls.user = null;
    const access = await checkCloudflareAccess(here());
    expect(access.state).toBe("token_invalid");
    expect(describeCloudflareAccess(access)).toMatch(/pithy cloudflare connect --profile pithy/);
    expect(describeCloudflareAccess(access)).not.toMatch(/CLOUDFLARE_API_TOKEN rejected/);
  });

  test("a signed-in user the account no longer answers for is account_unreachable, not ok", async () => {
    // Removed from the account, the person still answers `GET /user`. The account probe is what catches it.
    await signedIn();
    calls.reachable = false;
    const access = await checkCloudflareAccess(here());
    expect(access.state).toBe("account_unreachable");
    expect(describeCloudflareAccess(access)).toMatch(/still a member/);
  });

  test("bound and signed out is its own state, naming the profile and the sign-in", async () => {
    await bindProfile(project, "pithy", { env: { PITHY_CONFIG_DIR: dir } });
    const access = await checkCloudflareAccess(here());
    expect(access.state).toBe("signed_out");
    expect(describeCloudflareAccess(access)).toMatch(/profile pithy is bound here and is not signed in/);
  });

  test("an exported token that disagrees is reported, before anything reaches the network", async () => {
    await signedIn();
    const access = await checkCloudflareAccess(here({ CLOUDFLARE_API_TOKEN: "exported" }));
    expect(access.state).toBe("session_conflict");
    expect(calls.getUser).toBe(0);
  });

  test("offline, a signed-out or expired session is not checked, never a fault prescribing a sign-in", async () => {
    await bindProfile(project, "pithy", { env: { PITHY_CONFIG_DIR: dir } });
    expect((await checkCloudflareAccess(here({ PITHY_OFFLINE: "1" }))).state).toBe("not_checked");
    await signedIn("2026-10-15T11:00:00.000Z");
    expect((await checkCloudflareAccess(here({ PITHY_OFFLINE: "1" }))).state).toBe("not_checked");
  });

  test("an expired session is reported as one that could not be renewed", async () => {
    await signedIn("2026-10-15T11:00:00.000Z");
    expect((await checkCloudflareAccess(here())).state).toBe("session_expired");
  });
});

describe("pithy doctor, under an account token", () => {
  test("says the token is a name, not a person — the fact signing in would change", async () => {
    await writeFile(
      join(dir, "cloudflare.json"),
      JSON.stringify({ CLOUDFLARE_ACCOUNT_ID: "acct", CLOUDFLARE_API_TOKEN: "cfat_abc" }),
      { mode: 0o600 },
    );
    const access = await checkCloudflareAccess(here());
    expect(access.credentialKind).toBe("account-token");
    expect(describeCloudflareAccess(access)).toMatch(/audit rows name the token, not a person/);
  });
});

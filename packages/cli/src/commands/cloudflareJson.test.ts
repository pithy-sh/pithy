// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { boundProfileSync } from "../cloudflare/session/bindings";
import { readSessionSync, writeSession } from "../cloudflare/session/store";
import { expectConforms, runCaptured } from "../test-utils/payloadContract";

/**
 * **What `pithy cloudflare` writes under `--json`, held to the schema `pithy schema cloudflare` publishes (#759).**
 *
 * The browser half — the sign-in, the account listing, `GET /user`, the revocation — is replaced by what it
 * returns. Everything between the flags and the line is the real command: the session file it writes, the
 * binding it records, and the projection onto the payload. Nothing reaches Cloudflare.
 */

vi.mock("../cloudflare/session/connect", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../cloudflare/session/connect")>()),
  signIn: async () => ({
    accessToken: "AT",
    refreshToken: "RT",
    expiresAt: new Date("2026-10-15T13:00:00.000Z"),
    scope: "user-details.read offline_access account-api-tokens.write",
  }),
}));
vi.mock("../cloudflare/session/projectScopes", () => ({
  projectSessionScopes: async () => ({
    scopes: ["user-details.read", "offline_access", "account-api-tokens.write"],
    project: false,
  }),
}));
vi.mock("@pithy-sh/cloudflare/src/client/accounts", () => ({
  listCloudflareAccounts: async () => [{ id: "acct", name: "Acme" }],
}));
vi.mock("@pithy-sh/cloudflare/src/user/userManager", () => ({
  CloudflareUserManager: class {
    async getUser() {
      return { email: "dev@acme.test" };
    }
  },
}));
vi.mock("@pithy-sh/cloudflare/src/oauth/client", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@pithy-sh/cloudflare/src/oauth/client")>()),
  revokeToken: async () => {},
}));

let config: string;
let project: string;
const saved = { config: process.env.PITHY_CONFIG_DIR, noOpen: process.env.PITHY_NO_OPEN };

beforeEach(() => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "pithy-cf-json-")));
  config = join(root, "config");
  project = root;
  process.env.PITHY_CONFIG_DIR = config;
  process.env.PITHY_NO_OPEN = "1";
  vi.spyOn(process, "cwd").mockReturnValue(project);
});

afterEach(() => {
  vi.restoreAllMocks();
  if (saved.config === undefined) delete process.env.PITHY_CONFIG_DIR;
  else process.env.PITHY_CONFIG_DIR = saved.config;
  if (saved.noOpen === undefined) delete process.env.PITHY_NO_OPEN;
  else process.env.PITHY_NO_OPEN = saved.noOpen;
});

describe("pithy cloudflare --json conforms to its published payloads", () => {
  test("connect writes the session, binds the directory, and reports both", async () => {
    await expectConforms("cloudflare connect", await runCaptured("cloudflare connect", ["--json"]));
    expect(readSessionSync("default")).toMatchObject({ accountId: "acct", email: "dev@acme.test", refreshToken: "RT" });
  });

  test("disconnect, with a session and without one", async () => {
    await runCaptured("cloudflare connect", ["--json"]);
    await expectConforms("cloudflare disconnect", await runCaptured("cloudflare disconnect", ["--json"]));
    expect(readSessionSync("default")).toBeNull();
    await expectConforms("cloudflare disconnect", await runCaptured("cloudflare disconnect", ["--json"]));
  });

  test("use, bound to a directory and as the default", async () => {
    await expectConforms("cloudflare use", await runCaptured("cloudflare use", ["work", "--json"]));
    await expectConforms("cloudflare use", await runCaptured("cloudflare use", ["work", "--default", "--json"]));
  });

  test("disconnect --unbind also removes the binding, so the directory resolves as if none were made", async () => {
    await runCaptured("cloudflare connect", ["--json"]);
    expect(boundProfileSync(project)?.profile).toBe("default");
    await expectConforms("cloudflare disconnect", await runCaptured("cloudflare disconnect", ["--unbind", "--json"]));
    expect(boundProfileSync(project)).toBeNull();
  });

  test("a sign-in does not quietly move an existing profile to another account", async () => {
    await writeSession({
      profile: "default",
      accountId: "some-other-account",
      accountName: "Other",
      email: null,
      accessToken: "OLD",
      refreshToken: null,
      expiresAt: "2026-10-15T13:00:00.000Z",
      scope: "s",
    });
    const stderr: string[] = [];
    vi.spyOn(process.stderr, "write").mockImplementation((chunk: string | Uint8Array) => {
      stderr.push(String(chunk));
      return true;
    });
    await runCaptured("cloudflare connect", ["--json"]).catch(() => undefined);
    expect(stderr.join("")).toMatch(/already holds a session for account Other/);
    expect(readSessionSync("default")?.accessToken).toBe("OLD");
    // Named explicitly, the replacement is the person's decision, and it is made.
    await runCaptured("cloudflare connect", ["--profile", "default", "--json"]);
    expect(readSessionSync("default")?.accountId).toBe("acct");
  });
});

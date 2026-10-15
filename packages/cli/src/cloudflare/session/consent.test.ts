// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { mkdirSync, mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PithyError } from "@pithy-sh/core/src/error/pithyError";
import { describe, expect, test } from "vitest";
import { bindProfile } from "./bindings";
import { requireSessionConsent } from "./consent";
import { writeSession } from "./store";

async function signedIn(scope: string): Promise<{ cwd: string; env: NodeJS.ProcessEnv }> {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "pithy-consent-")));
  const env = { PITHY_CONFIG_DIR: join(root, "config") };
  const cwd = join(root, "project");
  mkdirSync(cwd);
  await bindProfile(cwd, "pithy", { env });
  await writeSession(
    {
      profile: "pithy",
      accountId: "acct",
      accountName: null,
      email: null,
      accessToken: "AT",
      refreshToken: "RT",
      expiresAt: "2026-10-15T13:00:00.000Z",
      scope,
    },
    { env },
  );
  return { cwd, env };
}

describe("requireSessionConsent", () => {
  test("a session granted everything the project needs is let through", async () => {
    const { cwd, env } = await signedIn("d1.write workers-scripts.write");
    expect(() => requireSessionConsent({ cwd, env, apiToken: "AT", needed: ["d1.write"] })).not.toThrow();
  });

  test("a capability composed since sign-in asks for consent, naming the permission and the sign-in", async () => {
    const { cwd, env } = await signedIn("d1.write");
    const failure = (() => {
      try {
        requireSessionConsent({ cwd, env, apiToken: "AT", needed: ["d1.write", "vectorize.write"] });
      } catch (error) {
        return error;
      }
    })();
    expect(failure).toBeInstanceOf(PithyError);
    expect((failure as PithyError).payload.message).toMatch(/vectorize\.write/);
    expect((failure as PithyError).payload.action).toMatch(/pithy cloudflare connect --profile pithy/);
  });

  test("a token that is not the bound session's is not its to judge", async () => {
    const { cwd, env } = await signedIn("d1.write");
    expect(() =>
      requireSessionConsent({ cwd, env, apiToken: "cfat_account-token", needed: ["vectorize.write"] }),
    ).not.toThrow();
  });
});

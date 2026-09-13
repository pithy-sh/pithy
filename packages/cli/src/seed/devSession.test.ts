// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { auth } from "@pithy-sh/auth/src/capability";
import { AUTH_SESSION_SECRET } from "@pithy-sh/auth/src/instance/secrets";
import { verifyDevLoginClaim } from "@pithy-sh/auth/src/seeds/devSession";
import { DEV_LOGIN_PATH } from "@pithy-sh/core/src/seed/devLogin";
import { EXAMPLE_ADA } from "@pithy-sh/core/src/seed/exampleIdentities";
import { describe, expect, test } from "vitest";
import { devSecretsFile } from "../devSecrets/location";
import { migrateProject } from "../migrations/run";
import { localWrangler, seedHarness } from "../test-utils/seedHarness";
import { seedProject } from "./run";

/**
 * The dev-session seed, composed against a project whose secret is where #153 and #156 put it — and
 * resolved through the **real** reader, not the `secret` seam.
 *
 * This is the test the suite did not have, and its absence is the whole of #176. `devSession`'s own
 * tests hand the set a secret through `context.secret`, so the seam is exercised and the thing behind
 * it never is; a unit test of `devSecretReader` alone has the same blind spot from the other side. The
 * reader kept reading `.dev.vars` after every `d1` secret moved out of it, and `pithy seed` on a real
 * project answered with two contradicting lines: the secret was seeded, and the seed that needs it
 * could not see it.
 *
 * So: the real capability, the real seed set, the real reader, and nothing in any `.dev.vars` ever.
 */

/** The project name, and so — with `PITHY_CONFIG_DIR` from `vitest.setup.ts` — where the secret lives. */
const PROJECT = "acme";

/** The dev value under test. Arbitrary, but it must be the one the minted cookie is signed with. */
const SECRET = "session-secret-from-the-dev-secrets-file";

/** Write one ordinary secret into `<config>/<project>/secrets.jsonc`, as the envelope its destination takes. */
async function writeDevSecret(name: string, value: string): Promise<string> {
  const path = devSecretsFile(PROJECT);
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await writeFile(path, `${JSON.stringify({ [name]: { currentVersion: "1", versions: { "1": value } } }, null, 2)}\n`, {
    mode: 0o600,
  });
  return path;
}

describe("the dev-session seed, through the real secret reader", () => {
  const h = seedHarness();

  test("mints a session from the dev secrets file, with nothing in any .dev.vars", async () => {
    await h.writeWrangler(localWrangler);
    await writeDevSecret(AUTH_SESSION_SECRET, SECRET);

    const capabilities = [auth({ baseURL: "http://localhost:8787" })];
    const workers = [h.api(capabilities)];
    await migrateProject({ account: null, workers, projectDir: h.projectDir, env: "dev", project: PROJECT });

    // No `secret` seam. The run resolves the value itself, from the file `pithy seed` writes.
    await seedProject({
      account: null,
      project: PROJECT,
      workers,
      projectDir: h.projectDir,
      env: "dev",
      includeExamples: true,
      preferences: async () => ({ user: EXAMPLE_ADA.email }),
    });

    // The claim is signed with the secret, so verifying it asserts the reader resolved that exact value —
    // not merely that something was written.
    const login: unknown = JSON.parse(await readFile(join(h.projectDir, DEV_LOGIN_PATH), "utf8"));
    const claim = (login as { claim: string }).claim;
    expect(await verifyDevLoginClaim(claim, SECRET)).toMatchObject({ userId: EXAMPLE_ADA.id });

    // **And no session row landed — `#572`.** The seed writes a file; the route mints the session when
    // the link is opened, which is what keeps signing out of the app from destroying the way back in.
    const store = await h.openLocal();
    try {
      const row = await store.d1.prepare("SELECT count(*) AS n FROM pithy_auth_sessions").first<{ n: number }>();
      expect(row?.n).toBe(0);
    } finally {
      await store.dispose();
    }

    // The point of #153: the secret is nowhere in the checkout, at either scope, at any point.
    for (const path of [join(h.projectDir, ".dev.vars"), join(h.workerDir, ".dev.vars")]) {
      expect(await readFile(path, "utf8").catch(() => "")).not.toContain(AUTH_SESSION_SECRET);
    }
  });
});

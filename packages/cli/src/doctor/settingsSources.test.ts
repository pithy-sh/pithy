// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { settingsAccountConnection, settingsEnvironments } from "./settingsSources";

let dir = "";
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "pithy-settings-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

async function project(environments: string[], wrangler: Record<string, unknown>): Promise<string> {
  await writeFile(
    join(dir, "pithy.config.ts"),
    `export default { name: "acme", environments: ${JSON.stringify(environments)} };\n`,
  );
  const workerDir = join(dir, "apps", "api");
  await mkdir(workerDir, { recursive: true });
  await writeFile(join(workerDir, "wrangler.jsonc"), JSON.stringify(wrangler, null, 2));
  return workerDir;
}

describe("the environments a check is handed", () => {
  test("are the ones the root config declares, each with the origin that Worker answers on", async () => {
    const workerDir = await project(["staging", "prod"], {
      name: "acme-api",
      env: { staging: { routes: ["staging.acme.dev/*"] }, prod: { routes: ["api.acme.dev/*"] } },
    });
    expect(await settingsEnvironments(dir, workerDir)).toEqual([
      { name: "staging", origin: "https://staging.acme.dev" },
      { name: "prod", origin: "https://api.acme.dev" },
    ]);
  });

  test("an environment nothing serves carries a null origin rather than being dropped", async () => {
    const workerDir = await project(["prod"], { name: "acme-api" });
    expect(await settingsEnvironments(dir, workerDir)).toEqual([{ name: "prod", origin: null }]);
  });

  test("an unreadable wrangler.jsonc still yields the declared set, with no origin claimed", async () => {
    await writeFile(join(dir, "pithy.config.ts"), `export default { name: "acme", environments: ["prod"] };\n`);
    const workerDir = join(dir, "apps", "api");
    await mkdir(workerDir, { recursive: true });
    await writeFile(join(workerDir, "wrangler.jsonc"), "{ not json");
    expect(await settingsEnvironments(dir, workerDir)).toEqual([{ name: "prod", origin: null }]);
  });
});

describe("reaching the account", () => {
  const connect = vi.fn();

  test("offline skips it before anything resolves", async () => {
    const answer = await settingsAccountConnection({
      account: null,
      project: "acme",
      offline: true,
      homedir: dir,
      env: { CLOUDFLARE_ACCOUNT_ID: "acct", CLOUDFLARE_API_TOKEN: "tok" },
      connect,
    });
    expect(answer).toEqual({ state: "skipped", reason: "offline" });
    expect(connect).not.toHaveBeenCalled();
  });

  test("no credentials is its own reason — a project not set up yet is not an unreachable one", async () => {
    const answer = await settingsAccountConnection({
      account: null,
      project: "acme",
      offline: false,
      env: {},
      homedir: dir,
      connect,
    });
    expect(answer).toEqual({ state: "skipped", reason: "no-credentials" });
  });

  test("credentials resolve into a reader that asks Cloudflare once per question", async () => {
    const listDatabases = vi.fn(async () => [{ name: "acme-global-email-suppressions", uuid: "id" }]);
    const findZoneForHostname = vi.fn(async (hostname: string) => (hostname === "acme.dev" ? { id: "z" } : null));
    const answer = await settingsAccountConnection({
      account: null,
      project: "acme",
      offline: false,
      env: { CLOUDFLARE_ACCOUNT_ID: "acct", CLOUDFLARE_API_TOKEN: "tok" },
      homedir: dir,
      connect: () =>
        ({
          d1Provisioner: () => ({ listDatabases }),
          zones: () => ({ findZoneForHostname }),
        }) as never,
      probe: () => ({ probe: async () => true }),
    });
    if (answer.state !== "reachable") throw new Error(`expected reachable, got ${answer.reason}`);

    expect(await answer.reader.d1Databases()).toEqual(["acme-global-email-suppressions"]);
    expect(await answer.reader.d1Databases()).toEqual(["acme-global-email-suppressions"]);
    // Memoized: every capability asks the same question, and a doctor run must cost one listing.
    expect(listDatabases).toHaveBeenCalledTimes(1);

    expect(await answer.reader.zone("acme.dev")).toBe(true);
    expect(await answer.reader.zone("example.com")).toBe(false);
    expect(await answer.reader.secret({ name: "email-link-signing-key", environment: "prod" })).toBe(true);
  });

  test("a secret asked about an environment no manager owns is not a claim", async () => {
    const answer = await settingsAccountConnection({
      account: null,
      project: "acme",
      offline: false,
      env: { CLOUDFLARE_ACCOUNT_ID: "acct", CLOUDFLARE_API_TOKEN: "tok" },
      homedir: dir,
      connect: () => ({}) as never,
      probe: () => ({
        probe: async () => {
          throw new Error("the probe should not be asked about dev");
        },
      }),
    });
    if (answer.state !== "reachable") throw new Error("expected reachable");
    // `dev` is local Miniflare — there is no manager Worker to ask, so the question is refused rather
    // than answered `false`, and the runner reports the capability's account tier as unchecked.
    await expect(answer.reader.secret({ name: "email-link-signing-key", environment: "dev" })).rejects.toThrow();
  });
});

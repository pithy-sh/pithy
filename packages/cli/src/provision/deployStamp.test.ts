// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import type { WorkflowHostTemplate } from "@pithy-sh/core/src/workflow/host";
import { describe, expect, test } from "vitest";
import { configHash, DEPLOY_STAMP_VAR, deployStamp, parseDeployStamp, stampConfig, stampVerdict } from "./deployStamp";

/** A resolved host config, the shape a provisioner hands to `wrangler deploy --config`. */
function config(overrides: Partial<WorkflowHostTemplate> = {}): WorkflowHostTemplate {
  return {
    name: "acme-prod-email",
    main: "./worker.js",
    compatibility_date: "2026-06-01",
    d1_databases: [{ binding: "DB", database_name: "acme-prod-db", database_id: "db-1" }],
    triggers: { crons: ["*/5 * * * *"] },
    vars: { BASE_URL: "https://acme.example", EMAIL_THEME: '{"brand":"#f5a"}' },
    ...overrides,
  };
}

describe("configHash", () => {
  test("is stable across key reordering in the committed template", () => {
    // The template is JSONC a human edits. Moving `vars` above `d1_databases` deploys nothing new, and
    // a hash that moved on it would redeploy every kit Worker on a comment-only edit.
    const ordered: WorkflowHostTemplate = {
      name: "acme-prod-email",
      main: "./worker.js",
      compatibility_date: "2026-06-01",
      d1_databases: [{ binding: "DB", database_name: "acme-prod-db", database_id: "db-1" }],
      triggers: { crons: ["*/5 * * * *"] },
      vars: { BASE_URL: "https://acme.example", EMAIL_THEME: '{"brand":"#f5a"}' },
    };
    const shuffled = {
      vars: { EMAIL_THEME: '{"brand":"#f5a"}', BASE_URL: "https://acme.example" },
      triggers: { crons: ["*/5 * * * *"] },
      d1_databases: [{ database_id: "db-1", binding: "DB", database_name: "acme-prod-db" }],
      compatibility_date: "2026-06-01",
      main: "./worker.js",
      name: "acme-prod-email",
    } as WorkflowHostTemplate;
    expect(configHash(shuffled)).toBe(configHash(ordered));
  });

  test("array order is inside the hash, because a reordered cron is a real change", () => {
    const one = config({ triggers: { crons: ["0 * * * *", "*/5 * * * *"] } });
    const other = config({ triggers: { crons: ["*/5 * * * *", "0 * * * *"] } });
    expect(configHash(one)).not.toBe(configHash(other));
  });

  test("excludes the stamp var from its own input", () => {
    // The var holds the hash. Left in, every run would hash a config carrying the previous run's hash
    // and never converge — the gate would be decoration that redeploys everything forever.
    const bare = config();
    const stamped = stampConfig(bare, "0.1.7");
    expect(stamped.vars?.[DEPLOY_STAMP_VAR]).toBeDefined();
    expect(configHash(stamped)).toBe(configHash(bare));
  });

  test("stamping a config twice reaches the same stamp, so a redeploy of an unchanged config skips", () => {
    const once = stampConfig(config(), "0.1.7");
    const twice = stampConfig(once, "0.1.7");
    expect(twice.vars?.[DEPLOY_STAMP_VAR]).toBe(once.vars?.[DEPLOY_STAMP_VAR]);
  });

  test("a var an adopter edited moves it — the silent half of the problem", () => {
    const before = config();
    const after = config({ vars: { ...before.vars, EMAIL_THEME: '{"brand":"#0af"}' } });
    expect(configHash(after)).not.toBe(configHash(before));
  });

  test("a resolved binding id moves it", () => {
    const after = config({ d1_databases: [{ binding: "DB", database_name: "acme-prod-db", database_id: "db-2" }] });
    expect(configHash(after)).not.toBe(configHash(config()));
  });

  test("a config with no vars at all hashes, and stamping it is what adds the block", () => {
    const bare = config({ vars: undefined });
    expect(configHash(bare)).toMatch(/^[0-9a-f]{16}$/);
    expect(stampConfig(bare, "0.1.7").vars).toEqual({ [DEPLOY_STAMP_VAR]: deployStamp(bare, "0.1.7") });
  });

  test("stamping leaves the caller's config alone", () => {
    const original = config();
    stampConfig(original, "0.1.7");
    expect(original.vars?.[DEPLOY_STAMP_VAR]).toBeUndefined();
  });
});

describe("deployStamp", () => {
  test("names the package version and the hash, separated by the one character semver cannot hold", () => {
    expect(deployStamp(config(), "0.1.7")).toBe(`0.1.7/${configHash(config())}`);
  });

  test("a prerelease version survives the round trip, punctuation and all", () => {
    const stamp = deployStamp(config(), "0.2.0-rc.1+build.5");
    expect(parseDeployStamp(stamp)).toEqual({ version: "0.2.0-rc.1+build.5", hash: configHash(config()) });
  });
});

describe("parseDeployStamp", () => {
  test.each<[string | undefined | null, string]>([
    ["", "empty"],
    [undefined, "absent"],
    [null, "null"],
    ["0.1.7", "no separator"],
    ["/abc123", "no version"],
    ["0.1.7/", "no hash"],
    ["0.1.7/abc/def", "a second separator"],
  ])("%s is not a stamp this release can read (%s)", (raw) => {
    expect(parseDeployStamp(raw)).toBeNull();
  });
});

/** The comparison every case below varies one field of. */
const base = { worker: "acme-prod-email", pkg: "@pithy-sh/email", current: "0.1.7/aaaaaaaaaaaaaaaa" } as const;

describe("stampVerdict", () => {
  test("matching version and hash is the one branch that skips", () => {
    const verdict = stampVerdict({ ...base, deployed: { state: "read", stamp: "0.1.7/aaaaaaaaaaaaaaaa" } });
    expect(verdict).toEqual({ deploy: false, reason: "@pithy-sh/email 0.1.7 is deployed with this configuration." });
  });

  test("--force deploys, and says so before it reads anything", () => {
    const verdict = stampVerdict({
      ...base,
      force: true,
      deployed: { state: "read", stamp: "0.1.7/aaaaaaaaaaaaaaaa" },
    });
    expect(verdict).toEqual({ deploy: true, reason: "--force was given." });
  });

  test("no Worker deploys — a first provision has no stamp to match", () => {
    expect(stampVerdict({ ...base, deployed: { state: "absent" } })).toEqual({
      deploy: true,
      reason: "acme-prod-email is not deployed.",
    });
  });

  test("a Worker deployed before this gate existed carries no stamp, and deploys", () => {
    expect(stampVerdict({ ...base, deployed: { state: "unstamped" } })).toEqual({
      deploy: true,
      reason: "acme-prod-email carries no deploy stamp.",
    });
  });

  test("an unreachable account deploys, and the reason carries what went wrong", () => {
    expect(stampVerdict({ ...base, deployed: { state: "unreadable", detail: "getaddrinfo ENOTFOUND" } })).toEqual({
      deploy: true,
      reason: "acme-prod-email's deploy stamp could not be read. getaddrinfo ENOTFOUND",
    });
  });

  test("a stamp in a shape this release cannot read deploys, rather than being guessed at", () => {
    expect(stampVerdict({ ...base, deployed: { state: "read", stamp: "who-knows" } })).toEqual({
      deploy: true,
      reason: "acme-prod-email's deploy stamp is not one this release can read.",
    });
  });

  test("a kit upgrade moves the version, and the reason names both", () => {
    expect(stampVerdict({ ...base, deployed: { state: "read", stamp: "0.1.6/aaaaaaaaaaaaaaaa" } })).toEqual({
      deploy: true,
      reason: "@pithy-sh/email moved from 0.1.6 to 0.1.7.",
    });
  });

  test("a config edit moves only the hash — the silent case, and it deploys", () => {
    expect(stampVerdict({ ...base, deployed: { state: "read", stamp: "0.1.7/bbbbbbbbbbbbbbbb" } })).toEqual({
      deploy: true,
      reason: "Its resolved configuration changed.",
    });
  });

  test("both moving is said as both, because a reader wants to know which upgrade this was", () => {
    expect(stampVerdict({ ...base, deployed: { state: "read", stamp: "0.1.6/bbbbbbbbbbbbbbbb" } })).toEqual({
      deploy: true,
      reason: "@pithy-sh/email moved from 0.1.6 to 0.1.7, and its resolved configuration changed.",
    });
  });

  test("every verdict carries a reason — a skip nobody can explain is the bug this closes", () => {
    const states = [
      { state: "read", stamp: "0.1.7/aaaaaaaaaaaaaaaa" },
      { state: "read", stamp: "0.1.6/aaaaaaaaaaaaaaaa" },
      { state: "read", stamp: "nonsense" },
      { state: "absent" },
      { state: "unstamped" },
      { state: "unreadable", detail: "401" },
    ] as const;
    for (const deployed of states) expect(stampVerdict({ ...base, deployed }).reason).not.toBe("");
  });
});

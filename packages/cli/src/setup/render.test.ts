// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { describe, expect, test } from "vitest";
import { externalLines, setupLines } from "./render";
import type { SetupReport } from "./run";

/** **What `pithy setup` says: one line per thing that happened, and silence for every step that did nothing (#764).** */

const DIR = "/home/you/acme";
const PATH = "/home/you/.config/pithy/acme/secrets.jsonc";

function report(overrides: Partial<SetupReport> = {}): SetupReport {
  return {
    dryRun: false,
    project: "acme",
    install: null,
    secrets: { path: PATH, minted: [], adopted: [], refused: [] },
    migrations: [],
    plannedMigrations: [],
    dev: { dev: null, allocated: false, devVars: [], devVarsDirs: [], seededSecrets: [], notes: [] },
    seed: { state: "none" },
    seedReport: null,
    external: [],
    notes: [],
    changed: false,
    ...overrides,
  };
}

describe("setupLines", () => {
  test("a fresh clone says each thing it did", () => {
    const lines = setupLines(
      DIR,
      report({
        secrets: { path: PATH, minted: ["SECRETS_ENCRYPTION_KEYS", "auth-session-secret"], adopted: [], refused: [] },
        migrations: ["0100_secrets_0001_init", "0300_auth_0001_init"],
        dev: {
          dev: {
            version: 1,
            branch: "main",
            ports: { index: 0, base: 8787, size: 20 },
            workers: { "acme-api": { port: 8787, origin: "http://localhost:8787" } },
          },
          allocated: true,
          devVars: [`${DIR}/apps/api`],
          devVarsDirs: [`${DIR}/apps/api`],
          seededSecrets: ["auth-session-secret"],
          notes: [],
        },
        seed: { state: "seeded" },
        changed: true,
      }),
    );

    expect(lines).toEqual([
      `Minted SECRETS_ENCRYPTION_KEYS and auth-session-secret into ${PATH}.`,
      "Migrated dev: 2 applied.",
      "acme-api: http://localhost:8787",
      "Generated .dev.vars for apps/api.",
      "Seeded auth-session-secret into the local secrets store.",
      "Seeded dev.",
    ]);
  });

  test("a second run says nothing changed, and nothing else", () => {
    expect(setupLines(DIR, report())).toEqual(["Already set up. Nothing changed."]);
  });

  test("feature sync's form leaves the ports and the verdict to the sync", () => {
    const allocated = report({
      dev: {
        dev: {
          version: 1,
          branch: "feature/7-x",
          ports: { index: 1, base: 8807, size: 20 },
          workers: { "acme-api": { port: 8807, origin: "http://localhost:8807" } },
        },
        allocated: true,
        devVars: [],
        devVarsDirs: [],
        seededSecrets: [],
        notes: [],
      },
    });

    expect(setupLines(DIR, allocated, { feature: true })).toEqual([]);
    expect(setupLines(DIR, report(), { feature: true })).toEqual([]);
  });

  test("a database holding rows is named, with the way to reset it", () => {
    const lines = setupLines(
      DIR,
      report({ seed: { state: "held", held: [{ worker: "acme-api", binding: "DB", table: "pithy_auth_users" }] } }),
    );

    expect(lines).toContain("dev holds rows in pithy_auth_users (DB), so it was not seeded.");
    expect(lines.some((line) => line.startsWith("`pithy seed --env dev --redo`"))).toBe(true);
  });
});

describe("externalLines", () => {
  test("each secret somebody else issues, with the command that opens its file", () => {
    expect(externalLines(report({ external: ["auth-github-client-secret", "payments-stripe-credentials"] }))).toEqual([
      "Issued by somebody else, so setup cannot supply them:",
      `  auth-github-client-secret — pithy secrets edit, into ${PATH}`,
      `  payments-stripe-credentials — pithy secrets edit, into ${PATH}`,
    ]);
  });

  test("none says nothing", () => {
    expect(externalLines(report())).toEqual([]);
  });
});

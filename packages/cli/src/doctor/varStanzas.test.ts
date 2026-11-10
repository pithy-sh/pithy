// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defineVars } from "@pithy-sh/core/src/worker/vars";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { z } from "zod";
import type { WorkerConfig } from "../project/config";
import {
  checkVarStanzas,
  describeVarStanzas,
  VAR_STANZAS_ACTION,
  varStanzaFindings,
  varStanzaGates,
} from "./varStanzas";

const VARS = defineVars({
  READY_AFTER_MINUTES: {
    description: "Minutes after the cron the next file is ready.",
    schema: z.number().int().min(0),
    default: 15,
    environments: { prod: 30 },
  },
});

const declared: WorkerConfig = { capabilities: [], vars: VARS };

describe("varStanzaFindings", () => {
  test("names an undeclared var the top level sets and a stanza drops, with the line to add", () => {
    const findings = varStanzaFindings("api", {
      vars: { ENVIRONMENT: "dev", FEED: "https://feed.example" },
      env: {
        staging: { vars: { ENVIRONMENT: "staging", FEED: "https://feed.example" } },
        prod: { vars: { ENVIRONMENT: "prod" } },
      },
    });
    expect(findings).toEqual([
      {
        worker: "api",
        kind: "missing",
        stanza: "env.prod",
        name: "FEED",
        declared: false,
        line: '"FEED": "https://feed.example"',
      },
    ]);
  });

  test("names a declared var a stanza drops, at that environment's value", () => {
    const findings = varStanzaFindings(
      "api",
      {
        vars: { READY_AFTER_MINUTES: 15 },
        env: { staging: { vars: { READY_AFTER_MINUTES: 15 } }, prod: { vars: {} } },
      },
      declared,
    );
    expect(findings).toEqual([
      {
        worker: "api",
        kind: "missing",
        stanza: "env.prod",
        name: "READY_AFTER_MINUTES",
        declared: true,
        line: '"READY_AFTER_MINUTES": 30',
      },
    ]);
  });

  test("names a declared var the top level lacks", () => {
    const findings = varStanzaFindings("api", { vars: {}, env: {} }, declared);
    expect(findings).toEqual([
      {
        worker: "api",
        kind: "missing",
        stanza: "vars",
        name: "READY_AFTER_MINUTES",
        declared: true,
        line: '"READY_AFTER_MINUTES": 15',
      },
    ]);
  });

  test("names a value its declaration refuses, in any stanza", () => {
    const findings = varStanzaFindings(
      "api",
      { vars: { READY_AFTER_MINUTES: 15 }, env: { prod: { vars: { READY_AFTER_MINUTES: "soon" } } } },
      declared,
    );
    expect(findings).toEqual([
      expect.objectContaining({ kind: "invalid", stanza: "env.prod", name: "READY_AFTER_MINUTES", value: "soon" }),
    ]);
  });

  test("leaves out a var the CLI writes per environment, which a stanza holds only once its command ran", () => {
    const record = JSON.stringify({ index: "dev-index", fields: ["tenant"] });
    const findings = varStanzaFindings("api", {
      vars: { ENVIRONMENT: "dev", BASE_URL: "http://localhost:8787", VECTOR_PROVISIONED: record },
      env: {
        staging: { vars: { ENVIRONMENT: "staging" } },
        prod: { vars: { ENVIRONMENT: "prod" } },
      },
    });
    expect(findings).toEqual([]);
  });

  test("gives ENVIRONMENT the stanza's own name, never the top level's", () => {
    const findings = varStanzaFindings("api", { vars: { ENVIRONMENT: "dev" }, env: { prod: { vars: {} } } });
    expect(findings).toEqual([
      {
        worker: "api",
        kind: "missing",
        stanza: "env.prod",
        name: "ENVIRONMENT",
        declared: false,
        line: '"ENVIRONMENT": "prod"',
      },
    ]);
  });

  test("names a var called like an object's own key that a stanza drops", () => {
    const findings = varStanzaFindings("api", { vars: { constructor: "x" }, env: { prod: { vars: {} } } });
    expect(findings.map((finding) => [finding.stanza, finding.name])).toEqual([["env.prod", "constructor"]]);
  });

  test("names a declared var a stanza holds at the top level's value where the Worker declares its own", () => {
    const findings = varStanzaFindings(
      "api",
      {
        vars: { READY_AFTER_MINUTES: 15 },
        env: { staging: { vars: { READY_AFTER_MINUTES: 15 } }, prod: { vars: { READY_AFTER_MINUTES: 15 } } },
      },
      declared,
    );
    expect(findings).toEqual([
      {
        worker: "api",
        kind: "copied",
        stanza: "env.prod",
        name: "READY_AFTER_MINUTES",
        value: 15,
        line: '"READY_AFTER_MINUTES": 30',
      },
    ]);
  });

  test("keeps a value set by hand that is not the top level's, whatever the declaration says", () => {
    const findings = varStanzaFindings(
      "api",
      { vars: { READY_AFTER_MINUTES: 15 }, env: { prod: { vars: { READY_AFTER_MINUTES: 45 } } } },
      declared,
    );
    expect(findings).toEqual([]);
  });

  test("leaves a stanza with no vars block to the inheritance check", () => {
    expect(varStanzaFindings("api", { vars: { FEED: "x" }, env: { prod: {} } })).toEqual([]);
  });

  test("a var only an environment sets is that environment's, and no finding", () => {
    expect(varStanzaFindings("api", { vars: {}, env: { prod: { vars: { BASE_URL: "https://x" } } } })).toEqual([]);
  });
});

describe("checkVarStanzas", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "pithy-var-stanzas-"));
    await mkdir(join(dir, "apps", "api"), { recursive: true });
    await writeFile(join(dir, "apps", "api", "pithy.worker.jsonc"), "{}\n");
    await writeFile(
      join(dir, "apps", "api", "wrangler.jsonc"),
      JSON.stringify({ name: "stats-api", vars: { FEED: "x" }, env: { prod: { vars: {} } } }),
    );
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  test("reads each Worker's wrangler.jsonc and its declaration", async () => {
    const check = await checkVarStanzas(dir, { loadConfig: async () => declared });
    expect(check.state).toBe("faulty");
    expect(check.findings.map((finding) => [finding.stanza, finding.name])).toEqual([
      ["vars", "READY_AFTER_MINUTES"],
      ["env.prod", "FEED"],
      ["env.prod", "READY_AFTER_MINUTES"],
    ]);
  });

  test("still checks undeclared vars when the config will not load", async () => {
    const check = await checkVarStanzas(dir, {
      loadConfig: async () => {
        throw new Error("Cannot find package 'zod'");
      },
    });
    expect(check.findings.map((finding) => finding.name)).toEqual(["FEED"]);
  });

  test("says ok when every stanza repeats every var", async () => {
    await writeFile(
      join(dir, "apps", "api", "wrangler.jsonc"),
      JSON.stringify({ vars: { FEED: "x" }, env: { prod: { vars: { FEED: "y" } } } }),
    );
    expect(await checkVarStanzas(dir, { loadConfig: async () => ({ capabilities: [] }) })).toEqual({
      state: "ok",
      findings: [],
    });
  });

  test("could-not-check when a wrangler.jsonc will not parse and nothing was found", async () => {
    await writeFile(join(dir, "apps", "api", "wrangler.jsonc"), "{ not json");
    expect((await checkVarStanzas(dir, { loadConfig: async () => ({ capabilities: [] }) })).state).toBe(
      "could-not-check",
    );
  });
});

describe("describeVarStanzas", () => {
  test("one sentence per finding, naming the Worker, the stanza and the line", () => {
    expect(
      describeVarStanzas({
        state: "faulty",
        findings: [
          { worker: "api", kind: "missing", stanza: "env.prod", name: "FEED", declared: false, line: '"FEED": "x"' },
          {
            worker: "api",
            kind: "missing",
            stanza: "vars",
            name: "READY_AFTER_MINUTES",
            declared: true,
            line: '"READY_AFTER_MINUTES": 15',
          },
          {
            worker: "api",
            kind: "invalid",
            stanza: "env.prod",
            name: "READY_AFTER_MINUTES",
            value: "soon",
            problem: "Invalid input: expected number, received string",
          },
          {
            worker: "api",
            kind: "copied",
            stanza: "env.prod",
            name: "READY_AFTER_MINUTES",
            value: 15,
            line: '"READY_AFTER_MINUTES": 30',
          },
        ],
      }),
    ).toEqual([
      'api: env.prod.vars has no FEED, which the top level sets. Add "FEED": "x".',
      'api: the top-level vars has no READY_AFTER_MINUTES, which the Worker declares. Add "READY_AFTER_MINUTES": 15, or run pithy worker sync --worker api.',
      'api: env.prod.vars sets READY_AFTER_MINUTES to "soon", which its declaration refuses: Invalid input: expected number, received string.',
      'api: env.prod.vars sets READY_AFTER_MINUTES to 15, the top level\'s value, where the Worker declares its own for prod. Set "READY_AFTER_MINUTES": 30, or run pithy worker sync --worker api.',
    ]);
    expect(VAR_STANZAS_ACTION).toMatch(/replaces the top-level block/);
  });

  test("says when it could not check", () => {
    expect(describeVarStanzas({ state: "could-not-check", findings: [] })).toEqual([
      "Could not compare the vars each Worker's stanzas set.",
    ]);
  });
});

describe("varStanzaGates", () => {
  const base = { worker: "api", stanza: "env.prod", name: "READY_AFTER_MINUTES" };

  test("a declared var a stanza lacks, refuses, or holds at the top level's value in place of its own gates", () => {
    expect(varStanzaGates({ ...base, kind: "missing", declared: true, line: "x" })).toBe(true);
    expect(varStanzaGates({ ...base, kind: "invalid", value: "soon", problem: "p" })).toBe(true);
    expect(varStanzaGates({ ...base, kind: "copied", value: 15, line: "x" })).toBe(true);
  });

  test("an undeclared var a stanza lacks reports only: nothing declares what it should be", () => {
    expect(varStanzaGates({ ...base, kind: "missing", declared: false, line: "x" })).toBe(false);
  });
});

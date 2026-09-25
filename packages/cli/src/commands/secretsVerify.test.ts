// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { ArgsDef, CommandDef } from "citty";
import { describe, expect, test } from "vitest";
import secrets from "./secrets";

/**
 * `pithy secrets verify` on the surface every agent, doc and completion script reads.
 *
 * The command body itself reaches a Cloudflare account and a deployed manager, so what is checked here
 * is the contract around it: that the subcommand is registered where the docs catalog and the shell
 * completions find it, that it is fully non-interactive, and that it supports `--json` — CLAUDE.md's
 * rule that every command is agent-drivable, which is a property of the declaration rather than of the
 * run.
 */

function subcommand(name: string): CommandDef {
  const entry = (secrets.subCommands as Record<string, CommandDef>)[name];
  if (!entry) throw new Error(`expected subcommand "${name}"`);
  return entry;
}

describe("pithy secrets verify", () => {
  test("is registered beside its siblings", () => {
    expect(Object.keys(secrets.subCommands as Record<string, CommandDef>)).toContain("verify");
  });

  test("takes env, sweep and json, and nothing else", () => {
    // Exact rather than a containment check: an argument added here is a surface an agent has to learn,
    // and one that arrives without a doc row fails `ci/docsCommands.test.ts` rather than this.
    expect(Object.keys(subcommand("verify").args as ArgsDef).sort()).toEqual(["env", "json", "sweep"]);
  });

  test("has no positional and no required argument, so it runs unattended", () => {
    const args = subcommand("verify").args as ArgsDef;

    for (const [name, definition] of Object.entries(args)) {
      expect(definition.type, `${name} must not be positional`).not.toBe("positional");
      expect("required" in definition && definition.required, `${name} must not be required`).toBeFalsy();
    }
  });

  test("sweeps by default, so --no-sweep is the opt-out rather than --sweep the opt-in", () => {
    // The orphan half is the one that finds #647's fingerprint. Off by default it would be a flag
    // nobody passes on the day it mattered.
    const sweep = (subcommand("verify").args as ArgsDef).sweep;

    expect(sweep?.type).toBe("boolean");
    expect(sweep && "default" in sweep && sweep.default).toBe(true);
  });

  test("supports --json, defaulting off", () => {
    const json = (subcommand("verify").args as ArgsDef).json;

    expect(json?.type).toBe("boolean");
    expect(json && "default" in json && json.default).toBe(false);
  });

  test("its body never asks a question", () => {
    // Read from the source because the gate is about what the command *can* do, not about what one run
    // did. `canPrompt` and a stdin read are the two ways a question reaches an operator in this file.
    const source = readFileSync(join(import.meta.dirname, "secrets.ts"), "utf8");
    const body = source.slice(source.indexOf("const verify = defineCommand("), source.indexOf("const provision ="));

    expect(body).not.toContain("canPrompt");
    expect(body).not.toContain("readSecretValue");
    expect(body).not.toContain("process.stdin");
    // The vacuity floor: the slice really is the verify command and not an empty string.
    expect(body).toContain("runSecretsVerification");
  });
});

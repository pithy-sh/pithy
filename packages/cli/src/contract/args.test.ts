// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import type { ArgsDef } from "citty";
import { describe, expect, test } from "vitest";
import { DeclaredFlag, DeclaredPositional, describeArgs, flagAliases } from "./args";

/**
 * **citty's rules, not its raw fields (#697).** What `pithy schema` says a command requires has to be
 * what citty refuses, or an agent builds a call the parser turns down.
 */
describe("describeArgs", () => {
  test("a positional with no `required` is required, as citty refuses it", () => {
    const { positionals } = describeArgs({ name: { type: "positional", description: "Cohort name" } });
    expect(positionals).toEqual([{ name: "name", required: true, variadic: false, description: "Cohort name" }]);
  });

  test("a positional is optional with `required: false` or a default", () => {
    const { positionals } = describeArgs({
      env: { type: "positional", required: false, description: "Environment" },
      scope: { type: "positional", default: "project", description: "Scope" },
    });
    expect(positionals.map(({ name, required }) => ({ name, required }))).toEqual([
      { name: "env", required: false },
      { name: "scope", required: false },
    ]);
    expect(positionals[1]?.default).toBe("project");
  });

  test("a string flag is required only when it says so", () => {
    const { flags } = describeArgs({
      issue: { type: "string", required: true, description: "Issue number" },
      worker: { type: "string", description: "Which Worker" },
    });
    expect(flags.map(({ name, required }) => ({ name, required }))).toEqual([
      { name: "--issue", required: true },
      { name: "--worker", required: false },
    ]);
  });

  test("a boolean with no default has no default: unset is its own state", () => {
    const { flags } = describeArgs({
      auth: { type: "boolean", description: "Wire auth" },
      json: { type: "boolean", default: false, description: "Machine-readable output" },
    });
    expect(flags[0]).not.toHaveProperty("default");
    expect(flags[1]?.default).toBe(false);
  });

  test("marks every other spelling as an alias of its canonical name", () => {
    const { flags } = describeArgs({
      "worker-url": { type: "string", description: "Override the address" },
      lines: { type: "string", alias: "n", description: "How many" },
      "with-prerequisites": { type: "boolean", default: false, description: "Compose prerequisites" },
    });
    expect(flags.map(({ name, aliases }) => ({ name, aliases }))).toEqual([
      { name: "--worker-url", aliases: [{ flag: "--workerUrl", kind: "camelCase" }] },
      { name: "--lines", aliases: [{ flag: "-n", kind: "declared" }] },
      {
        name: "--with-prerequisites",
        aliases: [
          { flag: "--withPrerequisites", kind: "camelCase" },
          { flag: "--no-with-prerequisites", kind: "negation" },
        ],
      },
    ]);
  });

  test("overlays the contract's facts: a fixed set of values, and repetition", () => {
    const { flags } = describeArgs(
      {
        scope: { type: "string", description: "Where to write" },
        set: { type: "string", description: "Override an option" },
      },
      { scope: { enum: ["project", "user"] }, set: { repeatable: true } },
    );
    expect(flags[0]).toMatchObject({ enum: ["project", "user"], repeatable: false });
    expect(flags[1]).toMatchObject({ repeatable: true });
    expect(flags[1]).not.toHaveProperty("enum");
  });

  test("a positional takes a fixed set of values from the contract too", () => {
    const { positionals } = describeArgs(
      { framework: { type: "positional", description: "Which stub" } },
      { framework: { enum: ["react"] } },
    );
    expect(positionals[0]).toMatchObject({ name: "framework", enum: ["react"] });
  });

  /**
   * citty declares one name per positional and hands every word past the last one to `args._`. A command
   * that reads them all — `pithy schema token mint` — has to say so, or a caller builds `schema "token mint"`.
   */
  test("a positional that takes every remaining word is published variadic, and no other is", () => {
    const { positionals } = describeArgs(
      {
        env: { type: "positional", required: false, description: "Environment" },
        command: { type: "positional", required: false, description: "Any number of words" },
      },
      { command: { variadic: true } },
    );
    expect(positionals.map(({ name, variadic }) => ({ name, variadic }))).toEqual([
      { name: "env", variadic: false },
      { name: "command", variadic: true },
    ]);
  });

  test("keeps the order of declaration, and a boolean's negative description", () => {
    const args: ArgsDef = {
      tui: { type: "boolean", default: true, description: "Live footer", negativeDescription: "Plain stream" },
      app: { type: "string", description: "Which app" },
    };
    const { flags } = describeArgs(args);
    expect(flags.map((flag) => flag.name)).toEqual(["--tui", "--app"]);
    expect(flags[0]?.negativeDescription).toBe("Plain stream");
  });

  test("everything it returns parses as what it publishes", () => {
    const { positionals, flags } = describeArgs({
      name: { type: "positional", description: "Name" },
      "key-id": { type: "string", alias: ["k"], description: "Key" },
      yes: { type: "boolean", description: "Skip the question" },
    });
    for (const positional of positionals) expect(DeclaredPositional.parse(positional)).toEqual(positional);
    for (const flag of flags) expect(DeclaredFlag.parse(flag)).toEqual(flag);
  });
});

describe("flagAliases", () => {
  test("camel case, then declared aliases long and short, then the negation", () => {
    expect(flagAliases("dry-run", { type: "boolean", alias: ["d", "dryrun"] })).toEqual([
      { flag: "--dryRun", kind: "camelCase" },
      { flag: "-d", kind: "declared" },
      { flag: "--dryrun", kind: "declared" },
      { flag: "--no-dry-run", kind: "negation" },
    ]);
  });

  test("no negation for a string flag: citty's --no-env is a parser quirk, not a flag", () => {
    expect(flagAliases("env", { type: "string" })).toEqual([]);
  });
});

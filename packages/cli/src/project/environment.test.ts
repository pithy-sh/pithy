// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { readdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { PithyError } from "@pithy-sh/core/src/error/pithyError";
import { DEFAULT_ENVIRONMENTS, MAX_ENVIRONMENT_NAME } from "@pithy-sh/core/src/naming/environment";
import { blankComments, blankCommentsAndStrings } from "@pithy-sh/core/src/text/comments";
import type { CommandDef } from "citty";
import { describe, expect, test } from "vitest";
import {
  ENV_ARG,
  requireEnvironment,
  requireManagedEnvironment,
  requireTeardownEnvironment,
  TEARDOWN_ENV_ARG,
} from "./environment";

const commandsDir = join(dirname(fileURLToPath(import.meta.url)), "..", "commands");

describe("requireEnvironment", () => {
  test("returns each first-class environment unchanged", () => {
    for (const env of ["dev", "staging", "prod"]) expect(requireEnvironment(env)).toBe(env);
  });

  test("refuses the old spelling with the new one", () => {
    expect(() => requireEnvironment("production")).toThrow(PithyError);
    try {
      requireEnvironment("production");
      expect.unreachable("production is not an environment");
    } catch (error) {
      expect(error).toBeInstanceOf(PithyError);
      expect((error as PithyError).payload.code).toBe("validation/invalid_input");
      expect((error as PithyError).payload.action).toBe("Use `prod`.");
    }
  });

  test("refuses an over-long environment — every project-name budget is derived against this length", () => {
    const tooLong = "a".repeat(MAX_ENVIRONMENT_NAME + 1);
    expect(() => requireEnvironment(tooLong)).toThrow(new RegExp(`stops at ${MAX_ENVIRONMENT_NAME}`));
  });

  test("refuses `global` — it is the scope beside the environments, not one of them", () => {
    expect(() => requireEnvironment("global")).toThrow(/scope, not an environment/);
  });

  test("refuses a name no Cloudflare namespace would take", () => {
    for (const bad of ["Prod", "2prod", "-dev", "dev_1", ""]) expect(() => requireEnvironment(bad)).toThrow(PithyError);
  });
});

describe("requireManagedEnvironment", () => {
  test("accepts the environments the project declared", () => {
    expect(requireManagedEnvironment("staging", DEFAULT_ENVIRONMENTS)).toBe("staging");
    expect(requireManagedEnvironment("prod", DEFAULT_ENVIRONMENTS)).toBe("prod");
  });

  test("accepts an environment core never heard of, once the project declares it", () => {
    expect(requireManagedEnvironment("live", ["staging", "live"])).toBe("live");
  });

  test("refuses an undeclared environment by name, listing the ones that are", () => {
    // The other half of #241: `--env live` used to be accepted by the naming rule and then skipped by
    // everything that iterated the closed enum. Undeclared is now a refusal, not a silence.
    try {
      requireManagedEnvironment("live", DEFAULT_ENVIRONMENTS);
      expect.unreachable("live is not declared");
    } catch (error) {
      expect(error).toBeInstanceOf(PithyError);
      const payload = (error as PithyError).payload;
      expect(payload.message).toContain("live");
      expect(payload.message).toContain("staging, prod");
      expect(payload.action).toContain("pithy.config.ts");
    }
  });

  test("refuses dev with the local answer, not a Zod stack trace", () => {
    try {
      requireManagedEnvironment("dev", DEFAULT_ENVIRONMENTS);
      expect.unreachable("dev is local-only");
    } catch (error) {
      expect(error).toBeInstanceOf(PithyError);
      expect((error as PithyError).payload.action).toContain("pithy dev");
    }
  });

  test("still refuses `production` at the naming rule, before the declaration is consulted", () => {
    expect(() => requireManagedEnvironment("production", DEFAULT_ENVIRONMENTS)).toThrow(/not an environment name/);
  });
});

describe("ENV_ARG", () => {
  test("names the three environments, so `--help` says what is legal without reading the source", () => {
    expect(ENV_ARG.description).toContain("dev");
    expect(ENV_ARG.description).toContain("staging");
    expect(ENV_ARG.description).toContain("prod");
  });
});

describe("requireTeardownEnvironment", () => {
  test("hands back the one environment named, when the project declares it", () => {
    expect(requireTeardownEnvironment("staging", DEFAULT_ENVIRONMENTS)).toBe("staging");
    expect(requireTeardownEnvironment("live", ["staging", "live"])).toBe("live");
  });

  // #591: a teardown with no target walked every declared environment. Absent is a refusal, never a default.
  test("refuses no environment at all, listing the declared ones", () => {
    try {
      requireTeardownEnvironment(undefined, DEFAULT_ENVIRONMENTS);
      expect.unreachable("a teardown has no default");
    } catch (error) {
      expect(error).toBeInstanceOf(PithyError);
      expect((error as PithyError).payload.message).toBe("Name the environment to deprovision. Nothing was deleted.");
      expect((error as PithyError).payload.action).toBe("Pass --env with one of: staging, prod.");
    }
  });

  test("refuses an undeclared environment the same way", () => {
    expect(() => requireTeardownEnvironment("live", DEFAULT_ENVIRONMENTS)).toThrow(
      '"live" is not an environment this project declares. Nothing was deleted.',
    );
  });

  // The naming rule runs first, so the answer to a misspelling is the spelling — not a list without it. This is
  // what makes the helper a validator the coverage gate below may accept, rather than a pass-through.
  test("runs the naming rule first: `production` is answered with `prod`", () => {
    try {
      requireTeardownEnvironment("production", DEFAULT_ENVIRONMENTS);
      expect.unreachable("production is not an environment");
    } catch (error) {
      expect((error as PithyError).payload.action).toBe("Use `prod`.");
    }
  });

  // `dev` is a reasonable thing to type and has nothing on Cloudflare to tear down. A list of what could be named
  // does not say that; `requireManagedEnvironment`'s answer did, before the teardowns moved here.
  test("refuses dev with the local answer, still saying nothing was deleted", () => {
    try {
      requireTeardownEnvironment("dev", DEFAULT_ENVIRONMENTS);
      expect.unreachable("dev is local-only");
    } catch (error) {
      expect(error).toBeInstanceOf(PithyError);
      expect((error as PithyError).payload.message).toBe(
        '"dev" is not an environment this project declares. Nothing was deleted.',
      );
      expect((error as PithyError).payload.action).toBe(
        "This tears down what a Cloudflare account holds, and dev is local-only. Run `pithy dev` instead.",
      );
    }
  });

  test("the flag it reads has no default to fall back on", () => {
    expect("default" in TEARDOWN_ENV_ARG).toBe(false);
  });

  // citty drops a flag a command does not declare, silently (#596). A teardown whose `--env` went undeclared would
  // receive nothing and refuse every run — or, spread from ENV_ARG, default to `dev`. Each declares this one.
  test.each(["email", "media", "secrets", "storage", "support"])("`pithy %s deprovision` declares it", async (name) => {
    const command = (await import(`../commands/${name}.ts`)).default as CommandDef;
    const deprovision = (command.subCommands as Record<string, CommandDef>).deprovision;
    expect((deprovision?.args as Record<string, unknown> | undefined)?.env).toBe(TEARDOWN_ENV_ARG);
  });
});

/**
 * The calls that check a `--env` value. {@link requireTeardownEnvironment} is here because it runs
 * {@link requireEnvironment} before anything else — pinned above by the `production` test, so it cannot
 * quietly become a pass-through and keep its place on this list.
 */
const ENV_VALIDATOR = /\b(?:requireEnvironment|requireManagedEnvironment|requireTeardownEnvironment)\s*\(/;

/** `.env`, `?.env`, `["env"]`, `?.["env"]`, each after an optional non-null `!`. */
const ENV_ACCESS = String.raw`\s*!?\s*(?:(?:\?\.|\.)\s*env\b|(?:\?\.)?\s*\[\s*(?:"env"|'env'|\`env\`)\s*\])`;

/** citty's `args` as a value: bare, off a context (`ctx.args`), or asserted (`(args as Args)`, `(<Args>args)`). */
const ARGS = String.raw`(?:\bargs\b|\(\s*args\s+(?:as|satisfies)\s[^;]*?\)|\(\s*<[^;]*?>\s*args\s*\))`;

/**
 * Every spelling of reading `--env` off citty's `args` this gate recognizes. The gate began as a substring
 * match on `args.env`; every row after the first is a spelling it once did not see.
 */
const ENV_READS: readonly RegExp[] = [
  // `args.env`, `args?.env`, `args!.env`, `args["env"]`, `ctx.args.env`, `(args as Args).env`, `(<Args>args).env`
  new RegExp(`${ARGS}${ENV_ACCESS}`),
  // `const { env } = args`, `const { env: target, json }: Args = args`, `const { env } = ctx.args`, `= args!`
  new RegExp(String.raw`\{[^{}]*\benv\b[^{}]*\}\s*(?::[^=;]*)?=\s*(?:[\w$]+\s*!?\s*\??\.\s*)*${ARGS}`),
  // `run: ({ args: { env } }) =>`
  /\bargs\s*:\s*\{[^{}]*\benv\b[^{}]*\}/,
];

/**
 * Whether a command's source reads `--env`, and whether it calls a validator. A read is looked for with comments
 * blanked and strings kept, so `${args.env}` in a template is still a read. A validator is looked for with strings
 * blanked too, so one named only in a message is not a call.
 */
function envCoverage(source: string): { reads: boolean; validates: boolean } {
  const code = blankComments(source);
  return {
    reads: ENV_READS.some((read) => read.test(code)),
    validates: ENV_VALIDATOR.test(blankCommentsAndStrings(source)),
  };
}

/**
 * The coverage gate. `--env` is a bare string on the wire, and the naming budgets every project name was
 * accepted under assume it is at most seven characters — so a command that reads `args.env` without
 * putting it through {@link requireEnvironment} composes Cloudflare names against a value nothing checked.
 * Grepping the command sources is crude, but it is the only check that fails when a *new* command forgets.
 *
 * **What it does not see**, stated so it can be checked:
 *
 * - **It is per file, not per read.** A file that validates one `--env` passes every other read in it.
 * - **Only `src/commands/*.ts`, one level.** A command defined anywhere else is not read.
 * - **Only a read off something named `args`.** It sees `args` bare, behind `!`, off a context (`ctx.args`),
 *   and inside a parenthesized `as`, `satisfies` or `<T>` assertion. It does not see an alias
 *   (`run: ({ args: a }) => a.env`, `const a = args; a.env`), a computed key (`args[key]`), a rest spread
 *   (`const { ...rest } = args; rest.env`), reflection (`Reflect.get(args, "env")`, `Object.entries(args)`),
 *   an assertion without parentheses around it, parentheses with no assertion inside (`const env = (args).env`,
 *   `const { env } = (args)`), or the value handed on by a caller (`dashboard.ts`'s `options.env`).
 * - **A destructure only when no brace comes between its `{` and `env`.** `const { env } = args`, with a type
 *   annotation, off `ctx.args`, and `({ args: { env } })` are seen. `const { flags: { dry }, env } = args` is not.
 * - **That a validator is called, not what it is applied to.** A call on a different value, or one whose result
 *   is discarded, still passes. Comments and string contents are blanked, so a validator named only in a comment
 *   or a message does not. A template literal is blanked whole, so a validator called only inside `${}` does not
 *   count either: that file is flagged, never passed.
 * - **Blanking is a scanner, not a parser, and these pass as a validator call that runs nothing.** A validator name
 *   inside a template literal nested in another's `${}`. A validator name inside a regex literal
 *   (`/requireEnvironment(/`), which is not blanked. A quoted validator name after a regex literal that follows a
 *   keyword, on the same line (`return /"/.test(s) ? "requireEnvironment(" : "";`): after `return` the `/` is read
 *   as division, the quote inside the regex opens a string, and every quote after it falls out of step.
 *   And a local pass-through function named like a validator (`const requireEnvironment = (v) => v;`): the name is
 *   what is matched, never which function it binds to.
 */
describe("every command with an --env flag validates it", () => {
  test("no command reads args.env without requireEnvironment", async () => {
    const files = (await readdir(commandsDir)).filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts"));
    const offenders: string[] = [];
    for (const file of files) {
      const { reads, validates } = envCoverage(await readFile(join(commandsDir, file), "utf8"));
      if (reads && !validates) offenders.push(file);
    }
    expect(offenders).toEqual([]);
  });

  // The gate proven able to fail, on every spelling it claims — including the ones the substring match missed.
  test.each([
    ["args.env", "const target = { environment: args.env, declared };"],
    ["args?.env", "const env = args?.env;"],
    ['args["env"]', 'const env = args["env"];'],
    ["args?.['env']", "const env = args?.['env'];"],
    ["destructured", "const { env, json } = args;"],
    ["destructured and renamed", "const {\n  env: target,\n} = args;"],
    ["destructured in the parameter", "run: ({ args: { env } }) => env,"],
    ["args!.env", "const env = args!.env;"],
    ['args!["env"]', 'const env = args!["env"];'],
    ["(args as Args).env", "const env = (args as Args).env;"],
    ["(args as unknown as Record<string, string>).env", "const env = (args as unknown as Record<string, string>).env;"],
    ["(args satisfies Args)?.env", "const env = (args satisfies Args)?.env;"],
    ["(<Args>args).env", "const env = (<Args>args).env;"],
    ["ctx.args.env", "run: (ctx) => ctx.args.env,"],
    ["destructured with a type", "const { env }: Args = args;"],
    ["destructured off ctx.args", "const { env } = ctx.args;"],
    ["destructured off context?.args", "const { json, env } = context?.args;"],
    ["destructured off args!", "const { env } = args!;"],
  ])("sees an unvalidated read spelled %s", (_, source) => {
    expect(envCoverage(source)).toEqual({ reads: true, validates: false });
  });

  test("a validator named only in a comment does not cover a read", () => {
    const source = "// requireEnvironment(args.env) runs later\nconst env = args.env;";
    expect(envCoverage(source)).toEqual({ reads: true, validates: false });
  });

  // A name in a string runs nothing. Blanking comments alone let a file whose only validator was a message pass.
  test.each([
    ["a double-quoted message", 'const env = args.env;\nconst hint = "call requireEnvironment(args.env) first";'],
    [
      "a single-quoted message",
      "const env = args.env;\nconst hint = 'requireTeardownEnvironment(args.env, declared)';",
    ],
    // biome-ignore lint/suspicious/noTemplateCurlyInString: the interpolation is the fixture, and has to arrive here uninterpolated.
    ["a template literal", "const env = args.env;\nconst hint = `run requireManagedEnvironment(${env}, declared)`;"],
  ])("a validator named only in %s does not cover a read", (_, source) => {
    expect(envCoverage(source)).toEqual({ reads: true, validates: false });
  });

  // Strings are blanked for the validator only: a read written inside a template is still a read.
  test("a read inside a template literal is still a read", () => {
    // biome-ignore lint/suspicious/noTemplateCurlyInString: the interpolation is the fixture, and has to arrive here uninterpolated.
    expect(envCoverage("const line = `env: ${args.env}`;")).toEqual({ reads: true, validates: false });
  });

  test("each validator covers a read", () => {
    for (const call of ["requireEnvironment", "requireManagedEnvironment", "requireTeardownEnvironment"]) {
      expect(envCoverage(`const env = ${call}(args.env, declared);`)).toEqual({ reads: true, validates: true });
    }
  });

  test("a flag that merely starts with env is not a read", () => {
    expect(envCoverage("const file = args.envFile;").reads).toBe(false);
    expect(envCoverage("const { envFile } = args;").reads).toBe(false);
    expect(envCoverage("const { env } = parseArgs(argv);").reads).toBe(false);
  });
});

// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { execFile } from "node:child_process";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, test } from "vitest";

/**
 * **`--json` formats for whoever is reading it — measured on the real bin, end to end.**
 *
 * Everything here runs under `execFile`, which pipes both streams, so `isTTY` is false on each: this is
 * the reader the contract has always been written for, and the file's first job is to prove that reader
 * still gets byte-identical output. What a *terminal* gets is `jsonPretty.pty.test.ts`, which needs a
 * kernel to answer honestly; the resolver's own matrix is `terminal/jsonMode.test.ts`.
 */

const run = promisify(execFile);
const bin = join(import.meta.dirname, "bin.ts");

/** The escape byte every ANSI sequence opens with. */
const ESC = "\u001b";

/** Every ANSI sequence, so an assertion can say "and it parses" about colored output. */
// biome-ignore lint/suspicious/noControlCharactersInRegex: matching the escape byte is the point.
const ANSI = /\u001b\[[0-9;]*m/g;

/** A child environment with the runner's own color and JSON signals scrubbed, so the bin decides. */
function cleanEnv(extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, TERM: "xterm-256color", PITHY_NO_UPDATE_NOTIFIER: "1" };
  for (const key of ["NO_COLOR", "FORCE_COLOR", "TEST", "CI", "PITHY_JSON"]) delete env[key];
  return { ...env, ...extra };
}

interface Failure {
  code: number;
  stdout: string;
  stderr: string;
}

/** Run the bin and hand back its streams whether it exited 0 or not. */
async function pithy(args: string[], env: NodeJS.ProcessEnv = cleanEnv()): Promise<Failure> {
  try {
    const { stdout, stderr } = await run("bun", [bin, ...args], { env });
    return { code: 0, stdout, stderr };
  } catch (error) {
    const failed = error as Failure & { code?: number };
    return { code: failed.code ?? 1, stdout: failed.stdout ?? "", stderr: failed.stderr ?? "" };
  }
}

describe("piped --json", () => {
  test("is exactly one compact line — the contract every script already parses", async () => {
    const { stdout } = await pithy(["doctor", "--json"]);
    expect(stdout.trimEnd().split("\n")).toHaveLength(1);
    expect(stdout).not.toContain(ESC);
    expect(JSON.parse(stdout)).toMatchObject({ cli: expect.any(Object) });
  });

  test("--pretty indents it, and it still parses", async () => {
    const { stdout } = await pithy(["doctor", "--json", "--pretty"]);
    expect(stdout.split("\n").length).toBeGreaterThan(1);
    expect(stdout).toContain('\n  "cli": {');
    expect(JSON.parse(stdout)).toMatchObject({ cli: expect.any(Object) });
  });

  /** The same document either way. Indenting changes the bytes; it must not change what they say. */
  test("compact and pretty are the same document", async () => {
    const compact = await pithy(["doctor", "--json"]);
    const pretty = await pithy(["doctor", "--json", "--pretty"]);
    expect(JSON.parse(pretty.stdout)).toEqual(JSON.parse(compact.stdout));
  });
});

describe("PITHY_JSON", () => {
  test("pretty forces indentation into a pipe, over --no-pretty", async () => {
    const { stdout } = await pithy(["doctor", "--json", "--no-pretty"], cleanEnv({ PITHY_JSON: "pretty" }));
    expect(stdout).toContain('\n  "cli": {');
    expect(JSON.parse(stdout)).toMatchObject({ cli: expect.any(Object) });
  });

  test("compact forces one line, over --pretty", async () => {
    const { stdout } = await pithy(["doctor", "--json", "--pretty"], cleanEnv({ PITHY_JSON: "compact" }));
    expect(stdout.trimEnd().split("\n")).toHaveLength(1);
  });

  /**
   * A typo'd variable reverting to the ambient default is indistinguishable from the variable working,
   * which is the surprise this whole feature exists to close. So it is refused, in both output shapes.
   */
  test("an unrecognized value exits 1 and names the two it takes", async () => {
    const { code, stderr, stdout } = await pithy(["doctor"], cleanEnv({ PITHY_JSON: "prety" }));
    expect(code).toBe(1);
    expect(stdout).toBe("");
    expect(stderr).toContain("PITHY_JSON");
    expect(stderr).toContain("compact");
    expect(stderr).toContain("pretty");
  });

  test("and under --json it is the one standard { error } line", async () => {
    const { code, stderr, stdout } = await pithy(["doctor", "--json"], cleanEnv({ PITHY_JSON: "prety" }));
    expect(code).toBe(1);
    expect(stdout).toBe("");
    const parsed = JSON.parse(stderr) as { error: { code: string; message: string; action: string } };
    expect(parsed.error.code).toBe("validation/invalid_input");
    expect(parsed.error.message).toContain("PITHY_JSON");
    expect(parsed.error.action).toContain("compact");
  });
});

describe("--pretty is paired with --json", () => {
  test("`pithy doctor --pretty` is refused, and says which flag it needs", async () => {
    const { code, stderr } = await pithy(["doctor", "--pretty"]);
    expect(code).toBe(1);
    expect(stderr).toContain("--pretty");
    expect(stderr).toContain("--json");
  });

  /** `remove` is the one command with no `--json` at all (docs/CLI.md §1.2). */
  test("`pithy remove --pretty` is refused", async () => {
    const { code, stderr } = await pithy(["remove", "auth", "--pretty"]);
    expect(code).toBe(1);
    expect(stderr).toContain("--pretty");
  });

  test("a value that is neither true nor false is refused, naming the token", async () => {
    const { code, stderr } = await pithy(["doctor", "--json", "--pretty=maybe"]);
    expect(code).toBe(1);
    const parsed = JSON.parse(stderr) as { error: { message: string; action: string } };
    expect(parsed.error.message).toContain("--pretty=maybe");
    expect(parsed.error.action).toContain("true");
  });

  test("`--pretty=true` and `--pretty=false` are read, not ignored", async () => {
    const on = await pithy(["doctor", "--json", "--pretty=true"]);
    expect(on.code).toBe(0);
    expect(on.stdout).toContain('\n  "cli": {');
    const off = await pithy(["doctor", "--json", "--pretty=false"]);
    expect(off.stdout.trimEnd().split("\n")).toHaveLength(1);
  });

  test("`--pretty=false` without --json is still refused — the pairing rule reads it too", async () => {
    const { code } = await pithy(["doctor", "--pretty=false"]);
    expect(code).toBe(1);
  });

  test("`--no-pretty` alone is refused on the same rule", async () => {
    const { code, stderr } = await pithy(["doctor", "--no-pretty"]);
    expect(code).toBe(1);
    expect(stderr).toContain("--no-pretty");
  });
});

describe("--pretty is a global flag, not fifty copies of a convention", () => {
  test("it is accepted wherever --json is, and never read as a typo", async () => {
    for (const args of [
      ["doctor", "--json", "--pretty"],
      ["doctor", "--pretty", "--json"],
    ]) {
      const { code, stderr } = await pithy(args);
      expect({ args, code, stderr }).toEqual({ args, code: 0, stderr: "" });
    }
  });

  test("it appears in the docs catalog's globalFlags", async () => {
    const { buildDocsCatalog } = await import("./docs/catalog");
    const global = new Set((await buildDocsCatalog()).globalFlags);
    expect(global.has("--pretty")).toBe(true);
    expect(global.has("--no-pretty")).toBe(true);
  });
});

describe("color sits behind pretty, and behind the color seam", () => {
  test("FORCE_COLOR colors the indented output, and it parses once stripped", async () => {
    const { stdout } = await pithy(["doctor", "--json", "--pretty"], cleanEnv({ FORCE_COLOR: "1" }));
    expect(stdout).toContain(ESC);
    expect(JSON.parse(stdout.replaceAll(ANSI, ""))).toMatchObject({ cli: expect.any(Object) });
  });

  test("NO_COLOR leaves indented JSON with zero ANSI bytes, and it parses", async () => {
    const { stdout } = await pithy(["doctor", "--json", "--pretty"], cleanEnv({ NO_COLOR: "1", FORCE_COLOR: "1" }));
    expect(stdout).not.toContain(ESC);
    expect(stdout).toContain('\n  "cli": {');
    expect(JSON.parse(stdout)).toMatchObject({ cli: expect.any(Object) });
  });

  test("FORCE_COLOR never colors a compact line — pretty is the gate color sits behind", async () => {
    const { stdout } = await pithy(["doctor", "--json"], cleanEnv({ FORCE_COLOR: "1" }));
    expect(stdout).not.toContain(ESC);
  });
});

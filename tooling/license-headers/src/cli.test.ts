import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { run } from "./cli";
import { buildHeader } from "./header";
import { canonicalText } from "./licenses";

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "pithy-cli-"));
  put("package.json", JSON.stringify({ name: "@pithy-sh/monorepo", license: "MIT" }));
  put("LICENSE", canonicalText("MIT") ?? "");
  put("packages/core/package.json", JSON.stringify({ name: "@pithy-sh/core", license: "MIT" }));
  put("packages/core/LICENSE", canonicalText("MIT") ?? "");
  put("packages/core/src/index.ts", `${buildHeader("MIT")}\n\nexport const a = 1;\n`);
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function put(relative: string, content: string): void {
  const path = join(root, relative);
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, content);
}

describe("run --check", () => {
  test("exits 0 on a clean repo", () => {
    expect(run(["--check"], root).code).toBe(0);
  });

  test("exits 1 and names every offending path", () => {
    put("packages/core/src/bare.ts", "export const b = 2;\n");
    put("packages/core/src/also.ts", "export const c = 3;\n");

    const result = run(["--check"], root);

    expect(result.code).toBe(1);
    expect(result.output).toContain("packages/core/src/bare.ts");
    expect(result.output).toContain("packages/core/src/also.ts");
  });

  test("says what is wrong, not just that something is", () => {
    put("packages/core/src/wrong.ts", `${buildHeader("FSL-1.1-MIT")}\n\nexport const b = 2;\n`);

    expect(run(["--check"], root).output).toContain("declares FSL-1.1-MIT, package is MIT");
  });

  // CLAUDE.md makes the action line a contract. `--fix` repairs headers and absent LICENSE files and
  // nothing else, so pointing at it for a mismatched licence body sends the developer to a command
  // that prints "Nothing to do." and exits 0 while the gate stays red.
  test("does not send the developer to --fix when nothing is fixable", () => {
    put("packages/core/LICENSE", "MIT License\n\nedited by hand\n");
    const result = run(["--check"], root);

    expect(result.code).toBe(1);
    expect(result.output).not.toContain("--fix");
    expect(result.output).toContain("by hand");
  });

  test("sends the developer to --fix when something is fixable", () => {
    put("packages/core/src/bare.ts", "export const b = 2;\n");

    expect(run(["--check"], root).output).toContain("--fix");
  });

  test("sends the developer to --fix when only some findings are fixable", () => {
    put("packages/core/src/bare.ts", "export const b = 2;\n");
    put("packages/core/LICENSE", "MIT License\n\nedited by hand\n");

    expect(run(["--check"], root).output).toContain("--fix");
  });

  test("changes nothing on disk", () => {
    put("packages/core/src/bare.ts", "export const b = 2;\n");
    run(["--check"], root);

    expect(readFileSync(join(root, "packages/core/src/bare.ts"), "utf8")).toBe("export const b = 2;\n");
  });

  test("defaults to checking when given no mode", () => {
    put("packages/core/src/bare.ts", "export const b = 2;\n");
    const result = run([], root);

    expect(result.code).toBe(1);
    expect(readFileSync(join(root, "packages/core/src/bare.ts"), "utf8")).toBe("export const b = 2;\n");
  });
});

describe("run --fix", () => {
  test("stamps the repo and exits 0", () => {
    put("packages/core/src/bare.ts", "export const b = 2;\n");
    const result = run(["--fix"], root);

    expect(result.code).toBe(0);
    expect(readFileSync(join(root, "packages/core/src/bare.ts"), "utf8")).toBe(
      `${buildHeader("MIT")}\n\nexport const b = 2;\n`,
    );
  });

  test("reports a clean repo as needing nothing", () => {
    const result = run(["--fix"], root);

    expect(result.code).toBe(0);
    expect(result.output).toContain("Nothing to do.");
  });

  test("leaves the tree clean, so a following --check passes", () => {
    put("packages/core/src/bare.ts", "export const b = 2;\n");
    run(["--fix"], root);

    expect(run(["--check"], root).code).toBe(0);
  });
});

// lint-staged appends the staged paths and only re-stages the files it passed in. A repo-wide fix
// would leave its edits unstaged and the commit would land headerless anyway.
describe("run --fix with explicit paths", () => {
  test("stamps only the paths it is given", () => {
    put("packages/core/src/staged.ts", "export const b = 2;\n");
    put("packages/core/src/untouched.ts", "export const c = 3;\n");

    run(["--fix", "packages/core/src/staged.ts"], root);

    expect(readFileSync(join(root, "packages/core/src/staged.ts"), "utf8")).toBe(
      `${buildHeader("MIT")}\n\nexport const b = 2;\n`,
    );
    expect(readFileSync(join(root, "packages/core/src/untouched.ts"), "utf8")).toBe("export const c = 3;\n");
  });

  test("exits 0 even though the rest of the repo is still unstamped", () => {
    put("packages/core/src/staged.ts", "export const b = 2;\n");
    put("packages/core/src/untouched.ts", "export const c = 3;\n");

    expect(run(["--fix", "packages/core/src/staged.ts"], root).code).toBe(0);
  });

  test("accepts an absolute path, as lint-staged passes", () => {
    put("packages/core/src/staged.ts", "export const b = 2;\n");

    run(["--fix", join(root, "packages/core/src/staged.ts")], root);

    expect(readFileSync(join(root, "packages/core/src/staged.ts"), "utf8")).toBe(
      `${buildHeader("MIT")}\n\nexport const b = 2;\n`,
    );
  });

  test("ignores a staged path that belongs to no package", () => {
    put("scripts/tool.ts", "export const b = 2;\n");

    expect(run(["--fix", "scripts/tool.ts"], root).code).toBe(0);
    expect(readFileSync(join(root, "scripts/tool.ts"), "utf8")).toBe("export const b = 2;\n");
  });

  test("never stamps a staged template file", () => {
    put("packages/core/templates/screen.tsx", "export const S = 1;\n");

    run(["--fix", "packages/core/templates/screen.tsx"], root);

    expect(readFileSync(join(root, "packages/core/templates/screen.tsx"), "utf8")).toBe("export const S = 1;\n");
  });
});

describe("run --help", () => {
  test("prints usage and exits 0", () => {
    const result = run(["--help"], root);

    expect(result.code).toBe(0);
    expect(result.output).toContain("--check");
    expect(result.output).toContain("--fix");
  });
});

describe("run with a bad flag", () => {
  test("names the flag and exits 2", () => {
    const result = run(["--wat"], root);

    expect(result.code).toBe(2);
    expect(result.output).toContain("--wat");
  });
});

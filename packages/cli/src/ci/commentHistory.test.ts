// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { GIT_NO_MAINTENANCE, removeTempDir, scratchGitEnv } from "../test-utils/tempRepo";
import {
  BASELINE_FILE,
  commentsIn,
  countHistory,
  DEFAULT_INCLUDE,
  type Drift,
  describeDrift,
  drift,
  historyMarkers,
  initialBaseline,
  LOWER_COMMAND,
  measure,
  parseBaseline,
  runCommentHistory,
  trackedFiles,
  withCounts,
} from "./commentHistory";

/** The repo root, four levels up from `packages/cli/src/ci`. */
const REPO_ROOT = resolve(import.meta.dirname, "..", "..", "..", "..");

/** Builds a marker the way a comment would hold it, so this file's own comments and strings stay plain. */
const hash = (digits: string) => `#${digits}`;

describe("the committed baseline", () => {
  test("matches the tree: no file's count has risen, appeared, or fallen without the baseline", () => {
    const baseline = parseBaseline(readFileSync(join(REPO_ROOT, BASELINE_FILE), "utf8"));
    const found = drift(baseline.counts, measure(REPO_ROOT, baseline));
    expect(found.map(describeDrift)).toEqual([]);
  });

  test("reads the globs the issue names, and finds files under each", () => {
    const baseline = parseBaseline(readFileSync(join(REPO_ROOT, BASELINE_FILE), "utf8"));
    expect(baseline.include).toEqual(DEFAULT_INCLUDE);
    const files = trackedFiles(REPO_ROOT, baseline.include, baseline.exclude);
    for (const prefix of ["packages/", "scripts/", "plugins/", "biome.jsonc"]) {
      expect(files.some((path) => path.startsWith(prefix))).toBe(true);
    }
    expect(files.some((path) => path.includes(".generated."))).toBe(false);
  });
});

describe("the module", () => {
  test("is repository tooling: kept out of the published build, its declarations and the tarball", () => {
    const cli = resolve(import.meta.dirname, "..", "..");
    const build = readFileSync(join(cli, "tsdown.config.ts"), "utf8");
    expect(build).toMatch(/libraryBuild\(\{\s*exclude: \[[^\]]*"src\/ci\/commentHistory\.ts"/);
    const tsconfig = readFileSync(join(cli, "tsconfig.build.json"), "utf8");
    expect(tsconfig).toContain(`"src/ci/commentHistory.ts"`);
    const manifest = JSON.parse(readFileSync(join(cli, "package.json"), "utf8")) as { files: string[] };
    expect(manifest.files).toContain("!src/ci/commentHistory.ts");
  });
});

describe("historyMarkers", () => {
  test("counts an issue reference, a cross-repo reference, issue and pull URLs, and a name with a date", () => {
    expect(historyMarkers(`see ${hash("123")} and ${hash("7")}`)).toEqual([hash("123"), hash("7")]);
    expect(historyMarkers(`fixed in pithy-sh/dashboard${hash("82")}`)).toEqual([`pithy-sh/dashboard${hash("82")}`]);
    expect(historyMarkers("https://github.com/pithy-sh/pithy/issues/860 and http://github.com/a/b/pull/9")).toEqual([
      "https://github.com/pithy-sh/pithy/issues/860",
      "http://github.com/a/b/pull/9",
    ]);
    expect(historyMarkers("decided by Jim, 2026-08-27, after a review")).toEqual(["Jim, 2026-08-27"]);
    expect(historyMarkers("(Jim Scott, 2026-08-27)")).toEqual(["Jim Scott, 2026-08-27"]);
  });

  test("does not count a bare date, a lowercase word before a date, or an acronym", () => {
    expect(historyMarkers("the compatibility date is 2026-06-01")).toEqual([]);
    expect(historyMarkers("measured 2026-10-17 on a sandbox")).toEqual([]);
    expect(historyMarkers("over SSH, 2026-10-15")).toEqual([]);
  });

  test("does not count a CSS hex color", () => {
    expect(historyMarkers("background #fff, border #1e293b")).toEqual([]);
    expect(historyMarkers(`black is ${hash("000")}, white is #ffffff, gray ${hash("666666")}`)).toEqual([]);
    expect(historyMarkers(`color: ${hash("333")}; fill="${hash("999")}"`)).toEqual([]);
    expect(historyMarkers(`stop-color='${hash("abc")}' box-shadow: 0 0 ${hash("1234")}`)).toEqual([]);
  });

  test("counts an issue reference written after a colon or an equals sign outside CSS", () => {
    expect(historyMarkers(`Fixed: ${hash("901")}`)).toEqual([hash("901")]);
    expect(historyMarkers(`TODO: ${hash("123")}`)).toEqual([hash("123")]);
    expect(historyMarkers(`which is the point: ${hash("207")}'s first draft`)).toEqual([hash("207")]);
    expect(historyMarkers(`issue=${hash("55")}`)).toEqual([hash("55")]);
    expect(historyMarkers(`color: ${hash("12345")}`)).toEqual([hash("12345")]);
  });

  test("does not count an HTML entity, a doubled hash, or a hash inside a word", () => {
    expect(historyMarkers(`&${hash("123")}; and #${hash("12")} and a${hash("12")}`)).toEqual([]);
  });

  test("does not count a URL that is not an issue or a pull", () => {
    expect(historyMarkers("https://github.com/pithy-sh/pithy/blob/main/x.ts#L12")).toEqual([]);
  });
});

describe("commentsIn", () => {
  test("TypeScript: line and block comments, and nothing in a string, template or regex", () => {
    const source = [
      `const a = "// ${hash("1")}";`,
      `const b = '${hash("2")}';`,
      `const c = \`${hash("3")} \${a} // ${hash("4")} \${\`${hash("5")}\`}\`;`,
      `const d = /\\/\\/ ${hash("6")}/;`,
      `const e = a.length / 2; // ${hash("7")}`,
      `/** ${hash("8")} */`,
      `const f = !/^ ${hash("9")}$/.test(a);`,
    ].join("\n");
    expect(commentsIn("x.ts", source)).toEqual([`// ${hash("7")}`, `/** ${hash("8")} */`]);
    expect(countHistory("x.ts", source)).toBe(2);
  });

  test("TypeScript: a comment after a template's closing brace is read", () => {
    const source = `const a = \`\${x}\`; // ${hash("1")}\nconst b = { c: \`\${{ d: 1 }.d}\` }; // ${hash("2")}`;
    expect(countHistory("x.ts", source)).toBe(2);
  });

  test("TypeScript: a hash before a backslash, where the scanner stalls, ends the walk", () => {
    const source = `if (ok) /^( ${hash("")}\\d+)?$/.test(b); // ${hash("4")}`;
    expect(countHistory("x.ts", source)).toBe(1);
  });

  test("TSX: JSX text and attribute strings are not comments; a JSX comment is", () => {
    const source = [
      "export function A() {",
      "  return (",
      `    <p title="// ${hash("1")}" data-x={\`${hash("2")}\`}>`,
      `      Read // ${hash("3")} at https://example.test`,
      "      Don't stop here.",
      `      {/* ${hash("4")} */}`,
      `      <b>{value /* ${hash("5")} */}</b>`,
      "    </p>",
      "  );",
      `} // ${hash("6")}`,
    ].join("\n");
    expect(commentsIn("a.tsx", source)).toEqual([`/* ${hash("4")} */`, `/* ${hash("5")} */`, `// ${hash("6")}`]);
  });

  test("TSX: a type parameter list is not JSX", () => {
    const source = `const id = <T,>(x: T) => x; // ${hash("1")}\nconst k = <T extends string>(x: T) => x; // ${hash("2")}`;
    expect(countHistory("a.tsx", source)).toBe(2);
  });

  test("JSONC: comments, never a string", () => {
    const source = `// ${hash("1")}\n{ "a": "// ${hash("2")}", /* ${hash("3")} */ "b": "x\\"// ${hash("4")}" }`;
    expect(commentsIn("a.jsonc", source)).toEqual([`// ${hash("1")}`, `/* ${hash("3")} */`]);
  });

  test("Grit: comments, never a backtick snippet or a string", () => {
    const source = `// ${hash("1")}\n\`console.log("// ${hash("2")}")\` where { $x <: r"// ${hash("3")}" }`;
    expect(commentsIn("a.grit", source)).toEqual([`// ${hash("1")}`]);
  });

  test("an extension it has no reader for is refused, naming the file", () => {
    expect(() => commentsIn("notes.md", "")).toThrow(/notes\.md/);
  });
});

describe("drift", () => {
  const baseline = { "rose.ts": 2, "fell.ts": 3, "gone.ts": 1, "same.ts": 4 };
  const actual = { "rose.ts": 3, "fell.ts": 1, "same.ts": 4, "new.ts": 2 };
  const found = drift(baseline, actual);

  test("names a count that rose, a new file with a marker, and a count that fell", () => {
    expect(found).toEqual<Drift[]>([
      { path: "fell.ts", kind: "fell", baseline: 3, actual: 1 },
      { path: "gone.ts", kind: "fell", baseline: 1, actual: 0 },
      { path: "new.ts", kind: "new", baseline: 0, actual: 2 },
      { path: "rose.ts", kind: "rose", baseline: 2, actual: 3 },
    ]);
  });

  test("each failure names the file, both counts and the command that lowers the baseline", () => {
    for (const entry of found) {
      const line = describeDrift(entry);
      expect(line).toContain(entry.path);
      expect(line).toContain(`${entry.actual} history marker`);
      expect(line).toContain(`${entry.baseline} in ${BASELINE_FILE}`);
      expect(line).toContain(LOWER_COMMAND);
    }
  });

  test("a tree that matches has none", () => {
    expect(drift({ "a.ts": 1 }, { "a.ts": 1 })).toEqual([]);
  });
});

describe("the baseline file", () => {
  test("round-trips, and lowering keeps everything above the counts as written", () => {
    const first = initialBaseline({ "b.ts": 2, "a.ts": 1 });
    expect(parseBaseline(first).counts).toEqual({ "a.ts": 1, "b.ts": 2 });
    const edited = first.replace("{\n", "{\n  // A note somebody added.\n");
    const lowered = withCounts(edited, { "b.ts": 1 });
    expect(lowered).toContain("// A note somebody added.");
    expect(parseBaseline(lowered).counts).toEqual({ "b.ts": 1 });
    expect(parseBaseline(withCounts(edited, {})).counts).toEqual({});
  });

  test("refuses counts that are not last, and a count below one", () => {
    expect(() => parseBaseline(`{ "counts": {}, "include": [] }`)).toThrow(/last key/);
    expect(() => parseBaseline(`{ "include": [], "counts": { "a.ts": 0 } }`)).toThrow(/a\.ts/);
  });
});

describe(`${LOWER_COMMAND}, on a scratch repository`, () => {
  let scratch = "";

  afterEach(async () => {
    await removeTempDir(scratch);
  });

  function repository(files: Record<string, string>): string {
    scratch = mkdtempSync(join(tmpdir(), "pithy-comment-history-"));
    for (const [path, text] of Object.entries(files)) {
      mkdirSync(dirname(join(scratch, path)), { recursive: true });
      writeFileSync(join(scratch, path), text);
    }
    git("init", "-q");
    git("add", ...Object.keys(files));
    return scratch;
  }

  function git(...args: string[]): void {
    execFileSync("git", [...GIT_NO_MAINTENANCE, ...args], { cwd: scratch, env: scratchGitEnv(), stdio: "ignore" });
  }

  const baselineText = () => readFileSync(join(scratch, BASELINE_FILE), "utf8");
  const counts = () => parseBaseline(baselineText()).counts;

  test("--init writes the first baseline from tracked files the globs cover, and refuses a second", () => {
    const root = repository({
      "packages/a/src/one.ts": `// ${hash("1")} ${hash("2")}\nexport const a = 1;\n`,
      "packages/a/src/two.generated.ts": `// ${hash("3")}\n`,
      "packages/a/src/clean.ts": "// Nothing to see.\n",
      "docs/page.ts": `// ${hash("4")}\n`,
    });
    writeFileSync(join(root, "packages/a/src/untracked.ts"), `// ${hash("5")}\n`);

    const first = runCommentHistory(root, ["--init"]);
    expect(first.code).toBe(0);
    expect(counts()).toEqual({ "packages/a/src/one.ts": 2 });

    const second = runCommentHistory(root, ["--init"]);
    expect(second.code).toBe(1);
    expect(second.output).toContain("already exists");
  });

  test("lowers a count that fell and drops a file that reached zero", () => {
    const root = repository({
      "packages/a/src/one.ts": `// ${hash("1")} ${hash("2")}\n`,
      "scripts/two.ts": `// ${hash("3")}\n`,
    });
    runCommentHistory(root, ["--init"]);
    writeFileSync(join(root, "packages/a/src/one.ts"), `// ${hash("1")}\n`);
    writeFileSync(join(root, "scripts/two.ts"), "// Clean.\n");

    const result = runCommentHistory(root, []);
    expect(result.code).toBe(0);
    expect(counts()).toEqual({ "packages/a/src/one.ts": 1 });
    expect(runCommentHistory(root, []).output).toContain("matches the tree");
  });

  test("refuses to raise a count or add a file, names each, and writes nothing", () => {
    const root = repository({
      "packages/a/src/one.ts": `// ${hash("1")}\n`,
      "packages/a/src/two.ts": `// ${hash("2")} ${hash("3")}\n`,
      "plugins/clean.grit": "// Clean.\n",
    });
    runCommentHistory(root, ["--init"]);
    writeFileSync(join(root, "packages/a/src/one.ts"), `// ${hash("1")} ${hash("9")}\n`);
    writeFileSync(join(root, "packages/a/src/two.ts"), `// ${hash("2")}\n`);
    writeFileSync(join(root, "plugins/clean.grit"), `// ${hash("4")}\n`);
    const before = baselineText();

    const result = runCommentHistory(root, []);
    expect(result.code).toBe(1);
    expect(result.output).toContain("packages/a/src/one.ts: 2 history markers, 1 in the baseline");
    expect(result.output).toContain("plugins/clean.grit: 1 history markers, 0 in the baseline");
    expect(result.output).not.toContain("two.ts");
    expect(baselineText()).toBe(before);
  });

  test("with no baseline, it says to run --init", () => {
    const root = repository({ "scripts/a.ts": "\n" });
    const result = runCommentHistory(root, []);
    expect(result.code).toBe(1);
    expect(result.output).toContain("--init");
  });
});

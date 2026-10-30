// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { spawnSync } from "node:child_process";
import { cp, mkdir, mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { LINT_RULES, OXLINT_PLUGIN, OXLINT_TEMPLATE } from "./lint";

/**
 * **The two rule sets cannot drift: both linters run over the same fixtures, and their findings must be equal.**
 *
 * A project laid out the way `pithy init` lays one out gets the starter's `biome.jsonc` and `.oxlintrc.json` as they
 * ship, both rule sets from `templates/starter/plugins/`, and every file in `packages/cli/lint-fixtures/` under
 * `apps/fixture/src/` — once as itself and once as a test, so each rule's test exclusion is held to its twin's too.
 * A finding is its file, its start and end offsets and its message; Biome's and Oxlint's sets of them must match
 * exactly, and every rule must find something, so two linters agreeing on nothing proves nothing.
 */

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..");
const STARTER = join(REPO, "templates", "starter");
const FIXTURES = join(REPO, "packages", "cli", "lint-fixtures");
const BIOME = join(REPO, "node_modules", "@biomejs", "biome", "bin", "biome");
const OXLINT = join(REPO, "node_modules", "oxlint", "bin", "oxlint");

/** One finding: where it is, as offsets into the file, and what it says. */
interface Finding {
  file: string;
  start: number;
  end: number;
  message: string;
}

const key = (finding: Finding) => `${finding.file}:${finding.start}-${finding.end} ${finding.message}`;

let dir: string;
const sources = new Map<string, string>();

/** A 1-based line and column in `file`, as an offset. The fixtures are ASCII, so a column is a character. */
function offsetOf(file: string, line: number, column: number): number {
  const lines = (sources.get(file) ?? "").split("\n");
  return lines.slice(0, line - 1).reduce((sum, text) => sum + text.length + 1, 0) + column - 1;
}

function run(command: string, args: string[]): string {
  const result = spawnSync(command, args, { cwd: dir, encoding: "utf8", env: { ...process.env, NO_COLOR: "1" } });
  if (result.error) throw result.error;
  return result.stdout;
}

function biomeFindings(): Finding[] {
  const report = JSON.parse(run(BIOME, ["lint", "--reporter=json", "."])) as {
    diagnostics: {
      category: string;
      message: string;
      location: { path: string; start: { line: number; column: number }; end: { line: number; column: number } };
    }[];
  };
  return report.diagnostics
    .filter((diagnostic) => diagnostic.category === "plugin")
    .map(({ message, location }) => ({
      file: location.path,
      start: offsetOf(location.path, location.start.line, location.start.column),
      end: offsetOf(location.path, location.end.line, location.end.column),
      message,
    }));
}

/** Oxlint's findings from the kit's plugin, by rule as well, so each rule can be asked whether it found anything. */
function oxlintFindings(): (Finding & { rule: string })[] {
  const report = JSON.parse(run(OXLINT, ["--format", "json"])) as {
    diagnostics: {
      code: string;
      message: string;
      filename: string;
      labels: { span: { offset: number; length: number } }[];
    }[];
  };
  return report.diagnostics
    .filter((diagnostic) => diagnostic.code.startsWith("pithy("))
    .map(({ code, message, filename, labels }) => {
      const span = labels[0]?.span ?? { offset: -1, length: 0 };
      return {
        rule: code.slice("pithy(".length, -1),
        file: filename,
        start: span.offset,
        end: span.offset + span.length,
        message,
      };
    });
}

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "pithy-lint-parity-"));
  await cp(join(STARTER, "plugins"), join(dir, "plugins"), { recursive: true });
  await cp(join(STARTER, "biome.template.jsonc"), join(dir, "biome.jsonc"));
  await cp(join(STARTER, OXLINT_TEMPLATE), join(dir, ".oxlintrc.json"));
  const src = join(dir, "apps", "fixture", "src");
  await mkdir(src, { recursive: true });
  for (const name of await readdir(FIXTURES)) {
    const text = await readFile(join(FIXTURES, name), "utf8");
    const dot = name.indexOf(".");
    for (const copy of [name, `${name.slice(0, dot)}.test${name.slice(dot)}`]) {
      await cp(join(FIXTURES, name), join(src, copy));
      sources.set(`apps/fixture/src/${copy}`, text);
    }
  }
}, 60_000);

afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("the lint safeguards under Biome and Oxlint", () => {
  test("ships one Grit rule and one Oxlint rule per safeguard", async () => {
    const shipped = (await readdir(join(STARTER, "plugins"))).sort();
    expect(shipped).toEqual(
      [...LINT_RULES.map((rule) => `${rule}.grit`), OXLINT_PLUGIN.slice("plugins/".length)].sort(),
    );
  });

  test("keeps the fixtures ASCII, so a column is an offset", () => {
    for (const [file, text] of sources) expect(/^[\x20-\x7e\n]*$/.test(text), file).toBe(true);
  });

  test("finds the same things in the same places, with the same message", () => {
    const biome = biomeFindings().map(key).sort();
    const oxlint = oxlintFindings().map(key).sort();
    expect({
      biomeOnly: biome.filter((finding) => !oxlint.includes(finding)),
      oxlintOnly: oxlint.filter((finding) => !biome.includes(finding)),
    }).toEqual({ biomeOnly: [], oxlintOnly: [] });
  }, 60_000);

  test("every rule finds something in its own fixture, and nothing in a hook the starter excludes", () => {
    const findings = oxlintFindings();
    for (const rule of LINT_RULES) {
      expect(
        findings.filter((finding) => finding.rule === rule && finding.file.includes(`/${rule}.`)).length,
        rule,
      ).toBeGreaterThan(0);
    }
    expect(findings.filter((finding) => finding.file.includes("turnstile"))).toEqual([]);
  }, 60_000);
});

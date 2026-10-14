// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, test } from "vitest";

/**
 * **`release` moves when the release workflow says so, and at no other time (#719).**
 *
 * The `pithy` Claude Code plugin installs from `pithy-sh/pithy#release`, so whatever that branch holds is
 * what every user's Claude Code loads. The workflow pushes it in exactly one step, on a real release only,
 * after the publish and the push to `main`, and never with `--force`. No other workflow names the branch.
 *
 * Nothing on GitHub's side refuses anyone else yet: a ruleset that admits only the workflow needs an
 * identity GitHub accepts as a bypass, and it refuses GitHub Actions itself. `docs/RELEASING.md` says
 * what is open.
 */

const REPO_ROOT = resolve(import.meta.dirname, "..", "..", "..", "..");
const WORKFLOWS = resolve(REPO_ROOT, ".github", "workflows");

const release = readFileSync(resolve(WORKFLOWS, "release.yml"), "utf8");

/** One named step of a workflow, as text: from its `- name:` line to the next one. */
function step(workflow: string, name: string): string {
  const start = workflow.indexOf(`- name: ${name}\n`);
  if (start === -1) throw new Error(`release.yml has no step named "${name}".`);
  const next = workflow.indexOf("- name: ", start + 1);
  return workflow.slice(start, next === -1 ? undefined : next);
}

describe("the release workflow moves it", () => {
  const move = step(release, "Move the release branch");

  test("to the commit it just pushed to main, without force", () => {
    // biome-ignore lint/suspicious/noTemplateCurlyInString: a GitHub Actions expression is the fixture, not a template.
    expect(move).toContain("SHA: ${{ steps.push.outputs.sha }}");
    // biome-ignore lint/suspicious/noTemplateCurlyInString: a shell expansion is the fixture, not a template.
    expect(move).toContain('git push origin "${SHA}:refs/heads/release"');
    expect(move).not.toMatch(/--force|\s\+\$\{?SHA/);
  });

  test("only on a real release, never a dry run", () => {
    // biome-ignore lint/suspicious/noTemplateCurlyInString: a GitHub Actions expression is the fixture, not a template.
    expect(move).toContain("if: ${{ !inputs.dry_run }}");
  });

  test("after the publish, the push to main, and the restamp of everything a release stamps", () => {
    const at = (name: string) => release.indexOf(`- name: ${name}\n`);
    expect(at("Version the packages")).toBeLessThan(at("Restamp the kit's OpenAPI document"));
    expect(at("Restamp the kit's OpenAPI document")).toBeLessThan(at("Publish to npm"));
    expect(at("Publish to npm")).toBeLessThan(at("Commit and push"));
    expect(at("Commit and push")).toBeLessThan(at("Move the release branch"));
  });

  test("and no other workflow names the branch", () => {
    const others = readdirSync(WORKFLOWS)
      .filter((file) => /\.ya?ml$/.test(file) && file !== "release.yml")
      .filter((file) => /refs\/heads\/release\b/.test(readFileSync(resolve(WORKFLOWS, file), "utf8")));
    expect(others).toEqual([]);
    expect(release.match(/refs\/heads\/release\b/g)).toHaveLength(1);
  });
});

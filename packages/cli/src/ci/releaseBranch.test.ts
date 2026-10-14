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
 * The release job pushes as a deploy key (#749), because `main`'s ruleset refuses `GITHUB_TOKEN` and GitHub
 * will not take GitHub Actions as a bypass actor. Only its two push steps read the key. Nothing on GitHub's
 * side yet refuses anyone else a push to `release`.
 * `docs/RELEASING.md` says what is open.
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
    expect(move).toContain('push origin "${SHA}:refs/heads/release"');
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
    expect(at("Publish to npm")).toBeLessThan(at("Commit the release"));
    expect(at("Commit the release")).toBeLessThan(at("Push to main"));
    expect(at("Push to main")).toBeLessThan(at("Move the release branch"));
  });

  test("and no other workflow names the branch", () => {
    const others = readdirSync(WORKFLOWS)
      .filter((file) => /\.ya?ml$/.test(file) && file !== "release.yml")
      .filter((file) => /refs\/heads\/release\b/.test(readFileSync(resolve(WORKFLOWS, file), "utf8")));
    expect(others).toEqual([]);
    expect(release.match(/refs\/heads\/release\b/g)).toHaveLength(1);
  });
});

describe("the release workflow pushes as the deploy key", () => {
  // The key is durable, unlike the job's OIDC tokens, so it is read only where it pushes. A checkout that took
  // it would leave it on disk through `bun install`, the build, the publish and the commit hooks.
  const readers = ["Push to main", "Move the release branch"];

  test("in the two steps that push, each loading it for that step alone", () => {
    for (const name of readers) {
      const push = step(release, name);
      // biome-ignore lint/suspicious/noTemplateCurlyInString: a GitHub Actions expression is the fixture, not a template.
      expect(push).toContain("DEPLOY_KEY: ${{ secrets.RELEASE_DEPLOY_KEY }}");
      expect(push).toContain(`trap 'rm -f "$key"' EXIT`);
      expect(push).toContain("-o StrictHostKeyChecking=yes");
      // Nothing an earlier step planted runs while the key is on disk: no git hook, no ssh config.
      expect(push).toContain("git -c core.hooksPath=/dev/null push");
      expect(push).toContain("ssh -F /dev/null");
    }
  });

  test("never in the checkout, or in the step whose commit runs the hooks", () => {
    for (const checkout of release.split("- name: Checkout\n").slice(1))
      expect(checkout.split("- name: ")[0]).not.toContain("ssh-key");
    expect(step(release, "Commit the release")).not.toContain("RELEASE_DEPLOY_KEY");
  });

  test("and nowhere else in any workflow", () => {
    const reads = readdirSync(WORKFLOWS)
      .filter((file) => /\.ya?ml$/.test(file))
      .flatMap((file) => readFileSync(resolve(WORKFLOWS, file), "utf8").match(/RELEASE_DEPLOY_KEY/g) ?? []);
    expect(reads).toHaveLength(readers.length);
  });
});

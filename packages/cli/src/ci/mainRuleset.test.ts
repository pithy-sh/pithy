// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { readdir, readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, test } from "vitest";

/**
 * **`main` merges a pull request only on a green `CI` check and one approving review** (#700).
 *
 * The rule lives in GitHub, as a repository ruleset, and a setting nobody can read in a diff is a setting
 * nobody reviews. So its definition is committed at `.github/rulesets/main.json` and applied from there,
 * and this gate holds that file to the two things that make it protect anything:
 *
 * 1. **It requires the aggregate `CI` job, and only that, from GitHub Actions.** Every other job in
 *    `ci.yml` is named from its shard, and those names move when a package lands — a required check that
 *    names a job which no longer runs is a protection that silently stops protecting. `integration_id`
 *    pins the source, so a commit status called `CI` posted by any other app or token does not satisfy it.
 * 2. **`CI` hears from every other job.** It runs `if: always()` and passes a job that *succeeded or was
 *    skipped*, because a skip is how `plan` narrows a docs-only pull request. That makes `needs` the whole
 *    of what it checks. It once left `plan` out: a failing `plan` skips both test jobs, `CI` read two skips
 *    as two passes, and a pull request whose tests never ran reported green. A job missing from `needs` is
 *    a job whose failure the required check cannot see.
 *
 * `ci.yml` is read as text. There is no YAML parser in this monorepo (`mcp/yaml.ts` says why), and the
 * shape read here — top-level job keys, and each job's `name:`, `needs:` and `if:` — is one the file holds
 * to on purpose; the anchor test proves the reader found what it expects rather than passing on nothing.
 *
 * **What this cannot hold is a pull request's own workflows.** A `pull_request` run uses the workflow files
 * on the PR's merge commit, so a fork can edit the `ci` job, or add a job of its own named `CI` that exits 0,
 * and GitHub Actions posts a green `CI` for it — `integration_id` pins who posts the check, not what ran.
 * The approving review is the control for that, which is why the ruleset requires one and why `/vet` reads
 * any change under `.github/` line by line. This file keeps the repository's own workflows honest: exactly
 * one job named `CI`, in `ci.yml`, hearing from every other job.
 */

/** The repository root. This file lives at `packages/cli/src/ci/`. */
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..");

const RULESET = resolve(REPO_ROOT, ".github", "rulesets", "main.json");
const WORKFLOWS = resolve(REPO_ROOT, ".github", "workflows");
const CI_WORKFLOW = resolve(WORKFLOWS, "ci.yml");

/** GitHub Actions' app id, read off a `CI` check run on this repository's own pull requests. */
const GITHUB_ACTIONS_APP_ID = 15368;

/** The built-in repository admin role, as a ruleset's `bypass_actors` names it. */
const REPOSITORY_ADMIN_ROLE = 5;

interface Job {
  key: string;
  name?: string;
  needs: string[];
  condition?: string;
}

/**
 * A YAML scalar as GitHub reads it: a trailing comment dropped, one layer of quotes removed, and an
 * expression's `${{ }}` unwrapped — `if: ${{ always() }}` and `if: always()` are the same condition.
 */
function scalar(raw: string): string {
  let value = raw.replace(/\s+#.*$/, "").trim();
  const quoted = /^(["'])(.*)\1$/.exec(value);
  if (quoted?.[2] !== undefined) value = quoted[2];
  const expression = /^\$\{\{\s*(.*?)\s*\}\}$/.exec(value);
  if (expression?.[1] !== undefined) value = expression[1];
  return value;
}

/** The name GitHub gives a job's check run: its `name:`, or its key when it has none. */
function checkName(job: Job): string {
  return job.name ?? job.key;
}

const indentOf = (line: string): number => line.length - line.trimStart().length;

/**
 * Each top-level job under `jobs:`: its key, and its own `name:`, `needs:` and `if:`.
 *
 * Indentation is learned, not assumed — the first key under `jobs:` sets the job level, and the first line
 * deeper than a job's key sets its field level — so a workflow indented four spaces is read, not skipped.
 * `needs:` is taken as a scalar, a flow list, or a block list on the lines below it.
 */
function jobsOf(workflow: string): Job[] {
  const jobs: Job[] = [];
  let inJobs = false;
  let jobIndent: number | undefined;
  let fieldIndent: number | undefined;
  let current: Job | undefined;
  let readingNeeds = false;
  for (const line of workflow.split("\n")) {
    if (/^jobs:\s*(#.*)?$/.test(line)) {
      inJobs = true;
      continue;
    }
    if (!inJobs) continue;
    // A comment may sit at column 0 inside the mapping; only a new top-level key ends `jobs:`.
    if (/^\s*(#.*)?$/.test(line)) continue;
    const indent = indentOf(line);
    if (indent === 0) break;
    jobIndent ??= indent;
    if (indent === jobIndent) {
      const key = /^\s*([A-Za-z0-9_-]+):\s*(#.*)?$/.exec(line);
      current = key?.[1] ? { key: key[1], needs: [] } : undefined;
      if (current) jobs.push(current);
      fieldIndent = undefined;
      readingNeeds = false;
      continue;
    }
    if (!current) continue;
    fieldIndent ??= indent;
    if (indent > fieldIndent) {
      const item = /^\s*-\s+(.+)$/.exec(line);
      if (readingNeeds && item?.[1]) current.needs.push(scalar(item[1]));
      continue;
    }
    readingNeeds = false;
    if (indent !== fieldIndent) continue;
    const field = /^\s*(name|needs|if):(.*)$/.exec(line);
    if (!field?.[1] || field[2] === undefined) continue;
    const value = scalar(field[2]);
    if (field[1] === "name") current.name = value;
    if (field[1] === "if") current.condition = value;
    if (field[1] === "needs") {
      readingNeeds = value === "";
      current.needs = value
        .replace(/^\[|\]$/g, "")
        .split(",")
        .map((need) => scalar(need))
        .filter(Boolean);
    }
  }
  return jobs;
}

interface StatusCheck {
  context: string;
  integration_id?: number;
}

interface Rule {
  type: string;
  parameters?: {
    required_status_checks?: StatusCheck[];
    strict_required_status_checks_policy?: boolean;
    required_approving_review_count?: number;
    dismiss_stale_reviews_on_push?: boolean;
    require_last_push_approval?: boolean;
    required_review_thread_resolution?: boolean;
  };
}

interface Ruleset {
  name: string;
  target: string;
  enforcement: string;
  conditions: { ref_name: { include: string[]; exclude: string[] } };
  bypass_actors: { actor_type: string; actor_id: number; bypass_mode: string }[];
  rules: Rule[];
}

let ruleset: Ruleset;
let jobs: Job[];
let everyWorkflowJob: { file: string; job: Job }[];
let workflowFiles: string[];

beforeAll(async () => {
  ruleset = JSON.parse(await readFile(RULESET, "utf8")) as Ruleset;
  jobs = jobsOf(await readFile(CI_WORKFLOW, "utf8"));
  workflowFiles = (await readdir(WORKFLOWS)).filter((file) => /\.ya?ml$/.test(file)).sort();
  everyWorkflowJob = [];
  for (const file of workflowFiles) {
    for (const job of jobsOf(await readFile(resolve(WORKFLOWS, file), "utf8"))) everyWorkflowJob.push({ file, job });
  }
});

describe("the job reader", () => {
  test("reads past a comment at column 0, which YAML allows inside a mapping", () => {
    const workflow = [
      "on: pull_request",
      "jobs:",
      "  plan:",
      "    name: Plan",
      "# --- the rest ---",
      "",
      "  ci:",
      "    name: CI",
      "    needs: [plan]",
      "    if: always()",
      "permissions:",
      "  contents: read",
    ].join("\n");
    expect(jobsOf(workflow)).toEqual([
      { key: "plan", name: "Plan", needs: [] },
      { key: "ci", name: "CI", needs: ["plan"], condition: "always()" },
    ]);
  });

  test("takes a needs list in every spelling YAML allows", () => {
    const workflow = [
      "jobs:",
      "  a:",
      "    needs: plan",
      "  b:",
      "    needs: [plan, a]  # gates",
      "  c:",
      "    needs:",
      "      - plan",
      "      - b",
      "    runs-on: ubuntu-24.04",
    ].join("\n");
    expect(jobsOf(workflow).map((job) => job.needs)).toEqual([["plan"], ["plan", "a"], ["plan", "b"]]);
  });

  test("reads a workflow at any indentation", () => {
    const workflow = ["jobs:", "    a:", "        name: A", "        needs: [plan]", "    b:", "        name: B"].join(
      "\n",
    );
    expect(jobsOf(workflow)).toEqual([
      { key: "a", name: "A", needs: ["plan"] },
      { key: "b", name: "B", needs: [] },
    ]);
  });

  test("reads a scalar the way GitHub does: unquoted, uncommented, unwrapped", () => {
    const workflow = [
      "jobs:",
      "  a:",
      '    name: "CI"',
      // biome-ignore lint/suspicious/noTemplateCurlyInString: a GitHub Actions expression is the fixture, not a template.
      "    if: ${{ always() }}",
      "  b:",
      "    name: 'CI'  # the aggregate",
    ].join("\n");
    expect(jobsOf(workflow)).toEqual([
      { key: "a", name: "CI", needs: [], condition: "always()" },
      { key: "b", name: "CI", needs: [] },
    ]);
  });

  test("names a job with no name: by its key, as GitHub names its check", () => {
    expect(checkName({ key: "CI", needs: [] })).toBe("CI");
    expect(checkName({ key: "ci", name: "Aggregate", needs: [] })).toBe("Aggregate");
  });
});

function rule(type: string): Rule {
  const found = ruleset.rules.find((candidate) => candidate.type === type);
  if (!found) throw new Error(`The ruleset has no ${type} rule.`);
  return found;
}

describe("the main ruleset", () => {
  test("is active on the default branch", () => {
    expect(ruleset.target).toBe("branch");
    expect(ruleset.enforcement).toBe("active");
    expect(ruleset.conditions.ref_name.include).toEqual(["~DEFAULT_BRANCH"]);
  });

  test("lets repository admins past it, and nobody else", () => {
    expect(ruleset.bypass_actors).toEqual([
      { actor_type: "RepositoryRole", actor_id: REPOSITORY_ADMIN_ROLE, bypass_mode: "always" },
    ]);
  });

  test("requires the CI check, from GitHub Actions, on a branch current with main", () => {
    const checks = rule("required_status_checks").parameters;
    expect(checks?.required_status_checks).toEqual([{ context: "CI", integration_id: GITHUB_ACTIONS_APP_ID }]);
    expect(checks?.strict_required_status_checks_policy).toBe(true);
  });

  test("requires one approval, dismissed by a new push, and every conversation resolved", () => {
    const review = rule("pull_request").parameters;
    expect(review?.required_approving_review_count).toBe(1);
    expect(review?.dismiss_stale_reviews_on_push).toBe(true);
    expect(review?.require_last_push_approval).toBe(false);
    expect(review?.required_review_thread_resolution).toBe(true);
  });

  test("refuses a force push and a deletion from everyone but an admin", () => {
    rule("non_fast_forward");
    rule("deletion");
  });
});

describe("the job the ruleset requires", () => {
  test("the reader finds ci.yml's jobs", () => {
    expect(jobs.map((job) => job.key)).toEqual(expect.arrayContaining(["plan", "verify", "test", "ci"]));
  });

  test("the reader finds jobs in every workflow, so none is skipped by passing on nothing", () => {
    const files = new Set(everyWorkflowJob.map(({ file }) => file));
    expect([...files].sort()).toEqual(workflowFiles);
  });

  test("is the only job named CI in any of this repository's workflows", () => {
    expect(everyWorkflowJob.filter(({ job }) => checkName(job) === "CI").map(({ file }) => file)).toEqual(["ci.yml"]);
  });

  test("is one job in ci.yml, by the name the ruleset requires", () => {
    const required = rule("required_status_checks").parameters?.required_status_checks?.map((c) => c.context);
    for (const context of required ?? []) {
      expect(jobs.filter((job) => checkName(job) === context)).toHaveLength(1);
    }
  });

  test("reports whatever happened upstream", () => {
    expect(jobs.find((job) => checkName(job) === "CI")?.condition).toBe("always()");
  });

  test("needs every other job, so no failure is invisible to it", () => {
    const aggregate = jobs.find((job) => checkName(job) === "CI");
    const others = jobs.filter((job) => job !== aggregate).map((job) => job.key);
    expect([...(aggregate?.needs ?? [])].sort()).toEqual([...others].sort());
  });
});

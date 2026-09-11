// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { dirname, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { blankComments } from "@pithy-sh/core/src/text/comments";
import { describe, expect, test } from "vitest";
import { readSource, sourcePaths } from "./sourceFiles";

/**
 * The gate. **Nothing in this CLI builds the environment of a Cloudflare-capable child by hand.**
 *
 * #555: `pithy dev` spawned every `wrangler dev` with `process.env` copied wholesale, so wrangler
 * authenticated as whatever `CLOUDFLARE_API_TOKEN` the operator's shell held. On a machine with two
 * accounts, a magic link left through a tenant that does not own the sending domain — five attempts,
 * five failures, and a banner that had just said `Email: sending for real from noreply@pithy.sh.`
 *
 * The rule was not missing. It was written at the call sites: `project/deploy.ts` and
 * `capabilities/hostDeploy.ts` each carried their own copy of "read the pair, set the two keys", and
 * `dev` carried none. Three sites, two correct — this repository's usual arithmetic for a rule kept at
 * call sites instead of at the thing being called, and the same arithmetic `CloudflareConfigOptions`
 * records for the account argument itself.
 *
 * So the rule moved into `cloudflare/childEnv.ts` and this is what keeps it there. A module that spawns
 * a child which could reach the Cloudflare API must get that child's environment from the seam, and
 * every module that spawns something else is written down below by name and reason — because an
 * exception list whose reasons have quietly stopped being true is itself the failure mode (#211), and a
 * gate that silently skipped the one module it was built for would be worse than no gate (#415).
 *
 * **It reads comment-blanked source.** Every docblock in this package discusses `CLOUDFLARE_API_TOKEN`
 * and `spawn` at length, this file most of all, so a scan over raw text would accuse the prose rather
 * than the code.
 */

/** The repository root. This file lives at `packages/cli/src/ci/`; the anchor test below proves it. */
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..");

/** The CLI's own source — the only tree that spawns anything on an operator's machine. */
const CLI_SRC = resolve(REPO_ROOT, "packages", "cli", "src");

/** The seam. The one module allowed to assemble a credentialed child environment. */
const SEAM = resolve(CLI_SRC, "cloudflare", "childEnv.ts");

/**
 * Whether a module can start a child process at all: it imports `node:child_process`.
 *
 * **The import rather than the call, because the call is frequently not a call.** Five modules here
 * reach `execFile` through `promisify(execFile)` and invoke the result under a local name — `run(…)`,
 * `execFileAsync(…)` — so a scan for `execFile(` finds nothing in exactly the modules that spawn the
 * most. The import is the one thing every spawner must write, and it cannot be aliased away.
 */
const SPAWNS = /node:child_process/;

/**
 * The seam's two entry points, plus the two things built directly on them.
 *
 * `runWrangler` builds every one of its children through the seam, and `devCloudflareEnv` is the dev
 * session's single call to it — the value the preflight and the spawn both read, which is the whole
 * reason it is one call and not two (#555).
 *
 * The name rather than a call, because the orchestrator's is neither spelling: it reads
 * `(options.devCloudflareEnv ?? defaultDevCloudflareEnv)(…)`, so the seam arrives as a property and an
 * aliased import and is invoked through neither name. What is being asserted is that the module reaches
 * for the seam at all; that its *default* is the real one is `orchestrator.test.ts`'s.
 */
const THROUGH_SEAM = /\b(?:cloudflareChildEnv|credentialedChildEnv|[dD]evCloudflareEnv|runWrangler)\b/;

/** Either Cloudflare credential key, written as a literal anywhere in executable code. */
const CREDENTIAL_KEY = /CLOUDFLARE_(?:API_TOKEN|ACCOUNT_ID)/;

/**
 * Modules that spawn a child which cannot reach Cloudflare, each with the program it runs.
 *
 * By name and by reason, never by a pattern that would also excuse the next module to forget. A child
 * here is `git`, a package manager, a process lister, an editor, a browser opener, or `tsc` — none of
 * which authenticates to anything, and none of which would be made safer by a credential.
 */
const NOT_CLOUDFLARE: Readonly<Record<string, string>> = {
  "ci/distTypes.ts": "runs `tsc` against a packed tarball's types.",
  "ci/fileModes.ts": "runs `git ls-files` to read the index's mode bits.",
  "dev/openUrl.ts": "runs the platform's browser opener on a localhost URL.",
  "dev/ports.ts": "runs `lsof`/`ps` to find the workerd processes a previous session left.",
  "feature/create.ts": "runs the project's package manager to install a new worktree's dependencies.",
  "feature/ports.ts": "runs `git rev-parse` to key the port registry on the main checkout's root.",
  "feature/worktree.ts": "runs `git worktree` to create and prune a feature's checkout.",
  "platform/editor.ts": "runs the operator's `$EDITOR` on a config file.",
  "project/packageManager.ts": "runs a package manager to discover its version.",
  "project/templateFiles.ts": "runs `git ls-files` to enumerate a template's tracked files.",
  "project/workerCommand.ts": "runs the project's package manager to install after a worker is added.",
};

/** One module's path as the exception table spells it — repo-relative to `packages/cli/src`. */
function key(path: string): string {
  return relative(CLI_SRC, path).split(sep).join("/");
}

/** Every shipped module under `packages/cli/src`, with its comments blanked out. */
function cliModules(): { key: string; code: string }[] {
  const modules: { key: string; code: string }[] = [];
  for (const path of sourcePaths(CLI_SRC)) {
    const text = readSource(path);
    if (text === null) continue;
    modules.push({ key: key(path), code: blankComments(text) });
  }
  return modules;
}

describe("the credentialed-child seam", () => {
  test("this file's idea of where it lives is right, so a miss is a failure and not a silent pass", () => {
    // The anchor every repo-wide gate here carries: a scan rooted at the wrong directory finds nothing
    // and reports success, which is the one outcome worse than a false accusation.
    expect(cliModules().length).toBeGreaterThan(200);
    expect(cliModules().some((m) => m.key === "cloudflare/childEnv.ts")).toBe(true);
  });

  test("every module that spawns a Cloudflare-capable child gets its environment from the seam", () => {
    const offenders = cliModules()
      .filter((m) => SPAWNS.test(m.code))
      .filter((m) => !(m.key in NOT_CLOUDFLARE))
      .filter((m) => !THROUGH_SEAM.test(m.code))
      .map((m) => m.key);
    expect(offenders).toEqual([]);
  });

  test("no module but the seam names a credential key beside a Cloudflare-capable spawn", () => {
    // The narrower half: it catches a fourth hand-rolled copy of the overlay even where the spawn itself
    // is a helper away, because the giveaway is the key, not the call.
    //
    // The declared non-Cloudflare spawners are out of scope here rather than exempt from the rule. A
    // module may legitimately do both — `project/workerCommand.ts` runs `<pm> install` *and* reads the
    // pair to ask the account which scripts are live over REST — and at file granularity those two facts
    // are indistinguishable from an overlay. The test above is what establishes that such a module's
    // child cannot reach Cloudflare; this one asks about the rest.
    const offenders = cliModules()
      .filter((m) => SPAWNS.test(m.code) && CREDENTIAL_KEY.test(m.code))
      .filter((m) => key(SEAM) !== m.key && !(m.key in NOT_CLOUDFLARE))
      .map((m) => m.key);
    expect(offenders).toEqual([]);
  });

  test("every exception still spawns something, so a stale entry cannot sit here unnoticed", () => {
    // The other direction. #211's lesson: an exception list is only worth what its reasons are worth, so
    // an entry for a module that no longer spawns anything — or no longer exists — fails the build rather
    // than quietly excusing nothing.
    const spawners = new Set(
      cliModules()
        .filter((m) => SPAWNS.test(m.code))
        .map((m) => m.key),
    );
    const stale = Object.keys(NOT_CLOUDFLARE).filter((name) => !spawners.has(name));
    expect(stale).toEqual([]);
  });

  test("every exception says what it runs, in a sentence", () => {
    for (const [name, reason] of Object.entries(NOT_CLOUDFLARE)) {
      expect(reason, name).toMatch(/^runs .*\.$/);
    }
  });
});

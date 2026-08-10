// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { defineCapability } from "@pithy-sh/core/src/capability/capability";
import { PithyError } from "@pithy-sh/core/src/error/pithyError";
import { afterEach, beforeEach, expect, test } from "vitest";
import { sourceFiles } from "../ci/sourceFiles";
import type { WorkerConfig } from "../project/config";
import { runUiAdd } from "./flow";

/**
 * **A failed `pithy ui add` leaves the project as it found it.**
 *
 * The invariant is over the outcome, not the order — because the outcome is what the adopter meets.
 * `runUiAdd` wrote the whole template and *then* composed the app to derive the asset allowlist, so a
 * composition that threw left the files written and the wiring not. And the way out was blocked by the
 * command's own refusal: `pithy ui add` declines a Worker that already carries a front end, which is
 * correct and deliberate — `planFiles` calls it "the adding a UI twice error — clean and actionable,
 * never a partial overwrite" — but it could not tell a finished front end from one this command had
 * abandoned a minute earlier. The adopter was told the thing was done, by the run that failed to do it,
 * and the only way forward was deleting files by hand and working out which ones were the template's
 * (#259).
 *
 * It mattered more than it reads because the failure it interacts with was live: a freshly scaffolded
 * project composing `auth` or `email` could not compose at all (#258), so the step this ordering put
 * last was failing on the shortest path through the product.
 *
 * Checked the way the issue states it: **snapshot the tree, make the run fail, assert the tree is
 * byte-identical, then prove a later run still works.** A capability whose `routes` throws is the real
 * failure, reached through the real command — not a stub of the step.
 */

/** A capability whose route registration throws — what composing a broken config does. */
const EXPLODES: WorkerConfig = {
  capabilities: [
    defineCapability({
      name: "auth",
      requiredBindings: [],
      routes: () => {
        throw new PithyError({
          code: "core/internal",
          status: 500,
          message: "Missing required bindings: workflow:EMAIL_SENDER",
          action: "Provision workflow:EMAIL_SENDER.",
        });
      },
    }),
  ],
};

/** A capability that composes fine — the retry the adopter deserves after fixing theirs. */
const COMPOSES: WorkerConfig = {
  capabilities: [
    defineCapability({
      name: "auth",
      requiredBindings: [],
      routes: (app) => {
        app.get("/auth", (c) => c.json({}));
      },
    }),
  ],
};

const WORKER = "board";
const DEPLOYED = "replay-board";

let projectDir: string;
let workerDir: string;

beforeEach(async () => {
  projectDir = await mkdtemp(join(tmpdir(), "pithy-ui-rollback-"));
  workerDir = join(projectDir, "apps", WORKER);
  await mkdir(workerDir, { recursive: true });
  await writeFile(join(workerDir, "wrangler.jsonc"), `{\n  "name": "${DEPLOYED}"\n}\n`);
  await writeFile(join(workerDir, "pithy.worker.jsonc"), '{\n  "dev": { "autostart": true }\n}\n');
  await writeFile(
    join(workerDir, "package.json"),
    `${JSON.stringify({ name: DEPLOYED, scripts: { dev: "wrangler dev" } }, null, 2)}\n`,
  );
  await writeFile(join(projectDir, "tsconfig.json"), `${JSON.stringify({ files: [], references: [] }, null, 2)}\n`);
  await writeFile(
    join(projectDir, "pithy.config.ts"),
    'export default { name: "replay", environments: ["staging", "prod"] };\n',
  );
});

afterEach(async () => {
  await rm(projectDir, { recursive: true, force: true });
});

/**
 * Every file under `root`, project-relative, with its text — the snapshot the invariant compares.
 *
 * Through `ci/sourceFiles.ts`, the one walk, rather than a private traversal: `keep: () => true` widens
 * it from shipped source to every file, and everything else it already handles — a directory that
 * vanished mid-walk, a symlink it must not descend — is exactly what a snapshot over a tree another
 * process could touch needs. A sixth hand-rolled walk is what `sourceFiles.test.ts` exists to refuse.
 */
function snapshot(root: string): Record<string, string> {
  const files: Record<string, string> = {};
  for (const file of sourceFiles(root, { keep: () => true })) files[relative(root, file.path)] = file.text;
  return files;
}

function options(config: WorkerConfig) {
  return { projectDir, workerDir, config, framework: "react", packageManager: "bun" as const };
}

test("a run whose composition fails writes nothing, and the retry after it succeeds", async () => {
  const before = snapshot(projectDir);

  await expect(runUiAdd(options(EXPLODES))).rejects.toThrow(/EMAIL_SENDER/);

  // Byte-identical, and the directory listing too: a template file left behind is what blocks the retry,
  // and an empty `src/routes/` left behind is what makes the tree "clean" to a reader and not to a test.
  expect(snapshot(projectDir)).toEqual(before);

  // And the refusal that used to fire here does not: nothing was written, so nothing looks finished.
  const report = await runUiAdd(options(COMPOSES));
  expect(report.created).toContain("vite.config.ts");
  expect(report.skipped).toEqual([]);
  expect(report.runWorkerFirst).toContain("/auth");
});

test("a run that fails after the write puts every file back, including the ones it edited", async () => {
  // The failure that lands *after* `scaffoldFiles` and after the `assets` stanza is written: a Worker
  // `package.json` that is not valid JSON, which `wirePackage` refuses. This is the case ordering alone
  // cannot fix — putting the compose step first only removes the failure someone has already met, and
  // the next step added goes back on the end of the list.
  await writeFile(join(workerDir, "package.json"), "{ not json\n");
  const before = snapshot(projectDir);

  await expect(runUiAdd(options(COMPOSES))).rejects.toThrow(/not valid JSON/);

  // Byte-identical: the template files are gone again, `wrangler.jsonc` has no `assets` stanza, and the
  // adopter's broken `package.json` is exactly as broken as they left it. Nothing here repairs a file
  // this command did not write.
  expect(snapshot(projectDir)).toEqual(before);
});

test("the genuine refusal still fires — a Worker that really has a front end is not overwritten", async () => {
  await runUiAdd(options(COMPOSES));
  await expect(runUiAdd(options(COMPOSES))).rejects.toThrow(/already has a react front end/);
});

test("a second framework in one Worker is still refused outright", async () => {
  await runUiAdd(options(COMPOSES));
  await expect(runUiAdd({ ...options(COMPOSES), framework: "nope" })).rejects.toThrow(PithyError);
});

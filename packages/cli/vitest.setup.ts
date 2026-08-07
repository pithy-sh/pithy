// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll } from "vitest";

/**
 * Point every test in this package at a throwaway Pithy config directory.
 *
 * **The one thing that keeps a test suite off the operator's real credentials.** Since #156 a project's
 * dev secrets live at `<config>/<project>/secrets.jsonc`, keyed on the project's *name* — so two tests
 * that both scaffold `--name replay` write to one file, and on a developer's machine that file is
 * `~/.config/pithy/replay/secrets.jsonc`, beside the real ones. A flaky run during this work was
 * exactly that: two suites minting over each other. A test that means to assert on a path still passes
 * its own `PITHY_CONFIG_DIR` through the `StatePathOptions` seam; this is the floor under the ones that
 * do not, and under every code path that resolves the directory itself.
 *
 * One directory per test file, because vitest gives each file its own worker process and a shared one
 * would put the collision back at a different level. Removed when the file finishes.
 */
const dir = mkdtempSync(join(tmpdir(), "pithy-test-config-"));
process.env.PITHY_CONFIG_DIR = dir;

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Point every test in this repository at a throwaway Pithy config directory.
 *
 * **The floor under the seam, not a replacement for it.** Since #156 a project's dev secrets live at
 * `<config>/<project>/secrets.jsonc`, keyed on the project's *name*, so two tests that both scaffold
 * `--name replay` write to one file — and on a developer's machine that file is
 * `~/.config/pithy/replay/secrets.jsonc`, beside the real ones. #200 is what that costs when nothing
 * catches it: one `bun run test` left 36 directories in a maintainer's real config directory, each
 * holding a genuinely minted AES master key, and wrote `SECRETS_STORE_ID` into their real
 * `cloudflare.json`. A test that means to assert on a path still passes its own `PITHY_CONFIG_DIR`
 * through the `StatePathOptions` seam; this is the floor under the ones that do not.
 *
 * One directory per test file, because vitest gives each file its own module registry and a shared one
 * would put the collision back at a different level.
 *
 * **Repo-root, and it imports nothing.** Every package loads this one file — `vitest.shared.ts` hands
 * each config its absolute path — so there is one thing to get right rather than twenty. That is also
 * why the cleanup is `process.on("exit")` rather than vitest's `afterAll`: this file sits above every
 * `node_modules/` that holds vitest, so a bare `import … from "vitest"` here would resolve from the
 * repository root and find nothing. `node:` builtins always resolve. A worker killed outright leaves a
 * directory in the system temp dir, which is what the system temp dir is for.
 */
const dir = mkdtempSync(join(tmpdir(), "pithy-test-config-"));
process.env.PITHY_CONFIG_DIR = dir;

process.on("exit", () => {
  rmSync(dir, { recursive: true, force: true });
});

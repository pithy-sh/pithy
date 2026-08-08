// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { devSecretsTargets } from "./targets";

/**
 * {@link devSecretsTargets} against a real project on disk, because the defect it hides is not
 * visible against a fake. It read the **secrets capability's own `registry` option** rather than
 * `aggregateSecretRegistries` — the call the Worker itself makes at composition — and that took two
 * rounds in the live CLI to find: `pithy add secrets` writes `secrets({ rotationIntervalDays })` and
 * leaves `registry` for the adopter, so the slice is `undefined` on a config the CLI itself wrote,
 * and `email-link-signing-key` is email's declaration rather than something anyone re-types.
 *
 * The scaffold lands **inside the package**, not the OS tmpdir, for the two reasons the rest of the
 * CLI's on-disk suites do it: the config's `@pithy-sh/*` imports resolve against the workspace
 * node_modules, and vitest only transforms a TS config that lives under the project root.
 */
let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(import.meta.dirname, "..", "..", ".e2e-targets-"));
  await writeFile(join(dir, "pithy.config.ts"), "export default { name: 'replay' };\n");
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

/** Write one `apps/<name>/` carrying the capability composition `config` states. */
async function worker(name: string, config: string): Promise<void> {
  const workerDir = join(dir, "apps", name);
  await mkdir(workerDir, { recursive: true });
  await writeFile(join(workerDir, "wrangler.jsonc"), JSON.stringify({ name: `replay-${name}` }));
  await writeFile(join(workerDir, "pithy.worker.jsonc"), JSON.stringify({ dev: { autostart: true } }));
  await writeFile(join(workerDir, "pithy.config.ts"), config);
}

/**
 * What `pithy add secrets` actually writes — the rotation cadence, and no `registry` — beside a second
 * capability that declares a secret of its own. `email-link-signing-key` is email's declaration; it
 * reaches the seeder only through the aggregate.
 */
const SECRETS_AND_EMAIL = `
import { email } from "@pithy-sh/email/src/index";
import { secrets } from "@pithy-sh/secrets/src/index";

export default {
  capabilities: [
    secrets({ rotationIntervalDays: 30 }),
    email({ fromAddress: "noreply@example.com", fromName: "Replay", baseUrl: "https://board.example.com" }),
  ],
};
`;

describe("devSecretsTargets", () => {
  test("the registry is the aggregate every capability contributes to, not the secrets slice", async () => {
    await worker("board", SECRETS_AND_EMAIL);

    const targets = await devSecretsTargets(dir);

    expect(targets.map((t) => t.name)).toEqual(["replay-board"]);
    // email declares this; nobody re-types it into `secrets({ registry })`. Reading the slice alone
    // seeded nothing in a real project and threw outright in a scaffolded one.
    expect(Object.keys(targets[0]?.registry ?? {})).toContain("email-link-signing-key");
    expect(targets[0]?.dir).toBe(join(dir, "apps", "board"));
  });

  test("a Worker that never composed secrets is not a target, and not an error either", async () => {
    await worker("site", "export default { capabilities: [] };\n");

    expect(await devSecretsTargets(dir)).toEqual([]);
  });

  test("a project with no workers at all answers with none rather than throwing", async () => {
    // `pithy add` runs this in a directory that may be anything. Refusing here would make an empty
    // project fail a command that has nothing to do for it.
    expect(await devSecretsTargets(dir)).toEqual([]);
  });

  test("only the named Worker is a target when one is named", async () => {
    await worker("board", SECRETS_AND_EMAIL);
    await worker("api", SECRETS_AND_EMAIL);

    const targets = await devSecretsTargets(dir, { worker: "replay-board" });

    expect(targets.map((t) => t.name)).toEqual(["replay-board"]);
  });

  test("reload sees a config rewritten after this process first imported it", async () => {
    // `pithy add` rewrites `pithy.config.ts` and then seeds, in one process that is still holding the
    // module it imported before the write. Without a reload the run seeds against the composition
    // from *before* the add — so the value it has just minted never reaches the store.
    await worker("board", "export default { capabilities: [] };\n");
    expect(await devSecretsTargets(dir)).toEqual([]);

    await worker("board", SECRETS_AND_EMAIL);

    expect(await devSecretsTargets(dir)).toEqual([]);
    const fresh = await devSecretsTargets(dir, { reload: true });
    expect(Object.keys(fresh[0]?.registry ?? {})).toContain("email-link-signing-key");
  });
});

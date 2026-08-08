// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { sourceFiles } from "../ci/sourceFiles";
import { resolveDevSecretsTargets } from "./targets";

/**
 * {@link resolveDevSecretsTargets} against a real project on disk, because the defect it hides is not
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

describe("resolveDevSecretsTargets", () => {
  test("the registry is the aggregate every capability contributes to, not the secrets slice", async () => {
    await worker("board", SECRETS_AND_EMAIL);

    const { targets } = await resolveDevSecretsTargets(dir);

    expect(targets.map((t) => t.name)).toEqual(["replay-board"]);
    // email declares this; nobody re-types it into `secrets({ registry })`. Reading the slice alone
    // seeded nothing in a real project and threw outright in a scaffolded one.
    expect(Object.keys(targets[0]?.registry ?? {})).toContain("email-link-signing-key");
    expect(targets[0]?.dir).toBe(join(dir, "apps", "board"));
  });

  test("a Worker that never composed secrets is not a target, and not an error either", async () => {
    await worker("site", "export default { capabilities: [] };\n");

    expect((await resolveDevSecretsTargets(dir)).targets).toEqual([]);
  });

  test("a project with no workers at all answers with none rather than throwing", async () => {
    // `pithy add` runs this in a directory that may be anything. Refusing here would make an empty
    // project fail a command that has nothing to do for it.
    expect((await resolveDevSecretsTargets(dir)).targets).toEqual([]);
  });

  test("only the named Worker is a target when one is named", async () => {
    await worker("board", SECRETS_AND_EMAIL);
    await worker("api", SECRETS_AND_EMAIL);

    const { targets } = await resolveDevSecretsTargets(dir, { worker: "replay-board" });

    expect(targets.map((t) => t.name)).toEqual(["replay-board"]);
  });

  test("a Worker whose config will not import is not silently 'declares no secrets' (#199)", async () => {
    // The defect this closes. `resolveWorkers` throws for a config that is present and will not load —
    // deliberately, so "No workers here" is never printed for a project that plainly has one — and this
    // module caught that into `[]`. An empty target list is also what a project with no secrets returns,
    // so every caller downstream read a broken config as "this Worker declares nothing", generated a
    // `.dev.vars` with no bindings in it, and said nothing at all.
    await worker("board", "export default { capabilities: [] };\n{{{ not typescript =");

    const resolution = await resolveDevSecretsTargets(dir);

    expect(resolution.targets).toEqual([]);
    expect(resolution.unresolvable.map((w) => w.name)).toEqual(["replay-board"]);
    expect(resolution.unresolvable[0]?.dir).toBe(join(dir, "apps", "board"));
    expect(resolution.unresolvable[0]?.reason).toContain("pithy.config.ts");
  });

  test("one Worker's broken config does not cost its siblings their bindings (#199)", async () => {
    // `resolveWorkers` fans out and throws on the first failure, so a single broken config took the
    // whole project's targets with it: the healthy Worker beside it got no registry, and therefore no
    // secrets, for a file it does not own. Resolution is per Worker so a failure costs exactly one.
    await worker("board", "export default { capabilities: [] };\n{{{ not typescript =");
    await worker("api", SECRETS_AND_EMAIL);

    const resolution = await resolveDevSecretsTargets(dir);

    expect(resolution.targets.map((t) => t.name)).toEqual(["replay-api"]);
    expect(resolution.unresolvable.map((w) => w.name)).toEqual(["replay-board"]);
  });

  test("a directory with no pithy.config.ts is skipped, not called unresolvable", async () => {
    // A Vite frontend joining the dev set through `pithy.worker.jsonc` alone has no config to import
    // and nothing to declare. Absent is the ordinary state; it is not a failure and must not be
    // reported as one, or every project with a frontend grows a permanent warning.
    const workerDir = join(dir, "apps", "site");
    await mkdir(workerDir, { recursive: true });
    await writeFile(join(workerDir, "wrangler.jsonc"), JSON.stringify({ name: "replay-site" }));
    await writeFile(join(workerDir, "pithy.worker.jsonc"), JSON.stringify({ dev: { autostart: true } }));

    expect(await resolveDevSecretsTargets(dir)).toEqual({ targets: [], unresolvable: [] });
  });

  test("reload sees a config rewritten after this process first imported it", async () => {
    // `pithy add` rewrites `pithy.config.ts` and then seeds, in one process that is still holding the
    // module it imported before the write. Without a reload the run seeds against the composition
    // from *before* the add — so the value it has just minted never reaches the store.
    await worker("board", "export default { capabilities: [] };\n");
    expect((await resolveDevSecretsTargets(dir)).targets).toEqual([]);

    await worker("board", SECRETS_AND_EMAIL);

    expect((await resolveDevSecretsTargets(dir)).targets).toEqual([]);
    const { targets: fresh } = await resolveDevSecretsTargets(dir, { reload: true });
    expect(Object.keys(fresh[0]?.registry ?? {})).toContain("email-link-signing-key");
  });
});

/**
 * **The tripwire, because this defect class has never had one producer (#199).**
 *
 * There used to be a lossy wrapper here — `devSecretsTargets`, which answered "which Workers declare
 * secrets" with a bare array. An array cannot say "and this one could not be asked", so every caller
 * read a config that would not import as a Worker that declares nothing. That is how `pithy dev` came
 * to write a `.dev.vars` with no bindings in it and print not one word, and four callers had made the
 * same mistake independently — the exact shape `readDevVarsSource`, `readDevJson`, `availableManifests`
 * and `workerUi` each had before it cost something.
 *
 * All four are routed now and the wrapper is deleted, so there is no lossy form to reach for. What is
 * left is the one thing a caller can still do: take `.targets` and drop `.unresolvable` on the floor.
 *
 * **That is sometimes right**, which is why this is a recorded list rather than a ban. `pithy seed`
 * drops it deliberately and says why at the call site: the command fails outright on an unloadable
 * config long before this runs, and inside `pithy dev` the generation step has already said it in one
 * sentence — saying it twice, in two blocks, is the correlation problem that sentence exists to end.
 *
 * So a new dropper costs a line here and a reason there. The first phrasing of this gate banned the
 * access outright and failed on exactly that one correct caller, which is the argument for recording
 * rather than forbidding: the shape is not wrong, it is wrong *unexplained*.
 */
const DROPS_UNRESOLVABLE = [
  // `pithy seed`. Reported already, twice over, before this function is reached — see the comment
  // above the call, which is the thing a fifth dropper has to write for itself.
  join("devSecrets", "seed.ts"),
];

test("every module that drops the unresolvable half is recorded (#199)", () => {
  const src = join(import.meta.dirname, "..");
  const droppers = sourceFiles(src)
    .filter((file) => !file.path.endsWith(".test.ts"))
    .filter((file) => !file.path.endsWith(join("devSecrets", "targets.ts")))
    .filter((file) => /\)\.targets\b|\bdevSecretsTargets\b/.test(file.text))
    .map((file) => file.path.slice(src.length + 1))
    .sort();

  expect(droppers).toEqual([...DROPS_UNRESOLVABLE].sort());
});

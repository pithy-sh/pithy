// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CloudflareClients } from "@pithy-sh/cloudflare/src/client/clients";
import { DEFAULT_ENVIRONMENTS } from "@pithy-sh/core/src/naming/environment";
import { afterAll, describe, expect, test } from "vitest";
import { CloudflareTurnstileProvisioner } from "../capabilities/turnstileProvisioner";
import { resolveTurnstileTarget } from "../commands/turnstile";
import { writeBootstrapVars } from "../devSecrets/bootstrapVars";
import { featureConfigPath } from "../provision/featureConfig";
import { linkKitPackages } from "../test-utils/linkKit";
import { checkTurnstileSitekeys, describeTurnstileSitekeys } from "./turnstileSitekeys";

/**
 * **Doctor says where Turnstile renders no widget, and where an older provisioner left sitekeys nothing reads**
 * (#590).
 *
 * Every fixture is a project on disk whose Worker config is loaded for real: the question is what the
 * capability resolves, and a fixture that stubbed the capability would certify the stub.
 */

const dirs: string[] = [];
afterAll(async () => {
  await Promise.all(dirs.map((dir) => rm(dir, { recursive: true, force: true })));
});

let projects = 0;

/** A one-Worker project: `apps/board`, with the given sitekeys, stanzas and declared environments. */
async function project(options: {
  sitekeys?: string;
  registration?: string;
  wrangler?: string;
  environments?: readonly string[];
}): Promise<{ projectDir: string; workerDir: string }> {
  const projectDir = await mkdtemp(join(tmpdir(), "pithy-doctor-turnstile-"));
  dirs.push(projectDir);
  projects += 1;
  const environments = options.environments ? `, environments: ${JSON.stringify(options.environments)}` : "";
  await writeFile(
    join(projectDir, "pithy.config.ts"),
    `export default { name: "doctor-turnstile-${projects}"${environments} };\n`,
  );
  const workerDir = join(projectDir, "apps", "board");
  await mkdir(workerDir, { recursive: true });
  await writeFile(join(workerDir, "wrangler.jsonc"), options.wrangler ?? '{ "name": "board" }');
  const registration =
    options.registration ??
    `turnstile({ widgets: { visible: { sitekeys: { ${options.sitekeys ?? 'dev: "", staging: "", prod: ""'} } } } })`;
  await writeFile(
    join(workerDir, "pithy.config.ts"),
    `import { turnstile } from "@pithy-sh/turnstile/src/capability";\nexport default { capabilities: [${registration}] };\n`,
  );
  await linkKitPackages(projectDir, ["turnstile"]);
  return { projectDir, workerDir };
}

const PROVISIONED = 'dev: "1x00000000000000000000AA", staging: "1x00000000000000000000AA", prod: "0x4AAAA"';

describe("checkTurnstileSitekeys", () => {
  test("a provisioned project on the default environments has nothing to say", async () => {
    const { projectDir } = await project({ sitekeys: PROVISIONED });

    const check = await checkTurnstileSitekeys(projectDir);

    expect(check).toEqual({ state: "ok", stranded: [], unrendered: [] });
    expect(describeTurnstileSitekeys(check)).toEqual([]);
  });

  test("blank sitekeys are named per environment, with the command that fills them and the redeploy", async () => {
    const { projectDir } = await project({ sitekeys: 'dev: "1x00000000000000000000AA", staging: "", prod: ""' });

    const check = await checkTurnstileSitekeys(projectDir);

    expect(check.unrendered).toEqual([
      { worker: "board", environment: "staging", slot: true },
      { worker: "board", environment: "prod", slot: true },
    ]);
    const text = describeTurnstileSitekeys(check).join("\n");
    expect(text).toContain("staging and prod");
    expect(text).toContain("pithy turnstile provision --worker board");
    expect(text).toMatch(/redeploy/i);
  });

  test("a declared environment no sitekey can reach is named as one, not as a step not taken", async () => {
    const { projectDir } = await project({ sitekeys: PROVISIONED, environments: ["staging", "live", "prod"] });

    const check = await checkTurnstileSitekeys(projectDir);

    expect(check.unrendered).toEqual([{ worker: "board", environment: "live", slot: false }]);
    const text = describeTurnstileSitekeys(check).join("\n");
    expect(text).toContain("live");
    expect(text).not.toContain("pithy turnstile provision");
  });

  test("a feature build renders the test widget, so it is never named (#656)", async () => {
    // It used to be named as an environment no sitekey could reach, which was true and was why nobody could
    // sign in to a branch deployment. A feature resolves Cloudflare's always-pass key with nothing stated,
    // so there is nothing to report — before the Worker has a generated feature config, and after.
    const { projectDir, workerDir } = await project({ sitekeys: PROVISIONED });
    expect((await checkTurnstileSitekeys(projectDir)).unrendered).toEqual([]);

    await mkdir(join(workerDir, ".wrangler", "pithy"), { recursive: true });
    await writeFile(featureConfigPath(workerDir), "{}");

    expect((await checkTurnstileSitekeys(projectDir)).unrendered).toEqual([]);
  });

  test("and a feature sitekey stated blank is still named — the check is not blind to a branch", async () => {
    // The plant. "A feature is fine" would pass the case above whatever the config said; this is the one
    // shape that renders no widget on a branch, and an adopter has to have written it deliberately.
    const { projectDir, workerDir } = await project({ sitekeys: `${PROVISIONED}, feature: ""` });
    await mkdir(join(workerDir, ".wrangler", "pithy"), { recursive: true });
    await writeFile(featureConfigPath(workerDir), "{}");

    expect((await checkTurnstileSitekeys(projectDir)).unrendered).toEqual([
      { worker: "board", environment: "feature", slot: true },
    ]);
  });

  test("each environment is judged from the composition for it, not from one composed for none (#595)", async () => {
    // A config is code, and this one asks which environment it is composed for: prod's widget is set only
    // when composed for prod, and staging's key is blanked only when composed for staging. Composed for no
    // environment it reads the other way round — prod blank, staging set — so a check that asks once, unstamped,
    // names prod, which renders, and misses staging, where nobody can sign in.
    const { projectDir } = await project({
      registration: [
        "turnstile({ widgets: { visible: { sitekeys: {",
        '  dev: "1x00000000000000000000AA",',
        '  staging: process.env.ENVIRONMENT === "staging" ? "" : "1x00000000000000000000AA",',
        '  prod: process.env.ENVIRONMENT === "prod" ? "0x4AAAA" : "",',
        "} } } })",
      ].join("\n"),
    });

    const check = await checkTurnstileSitekeys(projectDir);

    expect(check.unrendered).toEqual([{ worker: "board", environment: "staging", slot: true }]);
    expect(process.env.ENVIRONMENT).toBeUndefined();
  });

  test("a composition handed in is the one read, once per environment", async () => {
    const { projectDir, workerDir } = await project({ sitekeys: PROVISIONED });
    const asked: string[] = [];

    const check = await checkTurnstileSitekeys(projectDir, {
      composeWorker: async (worker, environment) => {
        asked.push(`${worker.dir === workerDir ? "board" : worker.dir}:${environment}`);
        return { capabilities: [] };
      },
    });

    expect(asked).toEqual(["board:dev", "board:staging", "board:prod"]);
    expect(check).toEqual({ state: "ok", stranded: [], unrendered: [] });
  });

  test("a Worker that gates no login is not reported, whatever its sitekeys say", async () => {
    const { projectDir } = await project({
      registration: 'turnstile({ protect: { contact: "invisible" }, widgets: {} })',
    });

    expect((await checkTurnstileSitekeys(projectDir)).unrendered).toEqual([]);
  });

  test("stranded sitekey vars are named with their environment and file, and what to run", async () => {
    const { projectDir, workerDir } = await project({
      sitekeys: 'dev: "", staging: "", prod: ""',
      wrangler: JSON.stringify({
        name: "board",
        vars: { TURNSTILE_SITEKEY_VISIBLE: "1x00" },
        env: { staging: { vars: { TURNSTILE_SITEKEY_VISIBLE: "1x00" } }, prod: { vars: { ENVIRONMENT: "prod" } } },
      }),
    });
    await writeBootstrapVars(projectDir, { TURNSTILE_SITEKEY_INVISIBLE: "1x00", KEEP: "1" });

    const check = await checkTurnstileSitekeys(projectDir);

    expect(check.state).toBe("findings");
    expect(check.stranded).toEqual([
      {
        worker: "board",
        name: "TURNSTILE_SITEKEY_VISIBLE",
        environment: "dev",
        file: join(workerDir, "wrangler.jsonc"),
        removedBy: "board",
      },
      {
        worker: "board",
        name: "TURNSTILE_SITEKEY_VISIBLE",
        environment: "staging",
        file: join(workerDir, "wrangler.jsonc"),
        removedBy: "board",
      },
      {
        worker: null,
        name: "TURNSTILE_SITEKEY_INVISIBLE",
        environment: "dev",
        file: expect.stringMatching(/dev\.json$/),
        removedBy: "board",
      },
    ]);
    const text = describeTurnstileSitekeys(check).join("\n");
    expect(text).toContain(join(workerDir, "wrangler.jsonc"));
    expect(text).toContain("TURNSTILE_SITEKEY_VISIBLE");
    expect(text).toContain("pithy turnstile provision");
  });

  test("a Worker config that will not load costs its own verdict, not the stranded-var one", async () => {
    const { projectDir, workerDir } = await project({
      wrangler: JSON.stringify({ name: "board", env: { prod: { vars: { TURNSTILE_SITEKEY_VISIBLE: "0x4AAA" } } } }),
    });
    await writeFile(join(workerDir, "pithy.config.ts"), "throw new Error('broken');\n");

    const check = await checkTurnstileSitekeys(projectDir);

    expect(check.state).toBe("findings");
    expect(check.stranded.map((found) => found.environment)).toEqual(["prod"]);
    expect(check.unrendered).toEqual([]);
  });

  test("nothing to read at all is could-not-check, never ok", async () => {
    const { projectDir, workerDir } = await project({});
    await writeFile(join(workerDir, "pithy.config.ts"), "throw new Error('broken');\n");

    expect(await checkTurnstileSitekeys(projectDir)).toEqual({
      state: "could-not-check",
      stranded: [],
      unrendered: [],
    });
  });
});

/**
 * **The remedy a stranded-var line names is one that clears it** (#590 review).
 *
 * Doctor reported a `TURNSTILE_SITEKEY_*` in every Worker's `wrangler.jsonc` and ended every line with
 * "pithy turnstile provision … removes this". Provisioning removes vars from the target Worker's file and
 * `dev.json` only, and refuses a target that does not compose turnstile — which is exactly where the old split
 * left vars. And #53's writer put sitekeys in the project root's `.dev.vars`, which doctor did not read.
 *
 * So the gate runs the remedy: for every finding that names a Worker, resolve it the way the command does and
 * run the real removal on it, then check again. Every such finding must be gone. A finding that names none
 * must say to delete it by hand.
 */
describe("a stranded-var finding and its remedy", () => {
  /** api composes turnstile; web composes nothing; each holds a stranded var, as do dev.json and the root .dev.vars. */
  async function strandedEverywhere() {
    const projectDir = await mkdtemp(join(tmpdir(), "pithy-doctor-stranded-"));
    dirs.push(projectDir);
    projects += 1;
    await writeFile(join(projectDir, "pithy.config.ts"), `export default { name: "doctor-stranded-${projects}" };\n`);
    const stranded = (name: string) =>
      JSON.stringify({ name, env: { prod: { vars: { TURNSTILE_SITEKEY_VISIBLE: "0x4AAAold" } } } });
    for (const [worker, registration] of [
      ["api", `turnstile({ widgets: { visible: { sitekeys: { ${PROVISIONED} } } } })`],
      ["web", ""],
    ] as const) {
      const workerDir = join(projectDir, "apps", worker);
      await mkdir(workerDir, { recursive: true });
      await writeFile(join(workerDir, "wrangler.jsonc"), stranded(worker));
      const imports = registration ? 'import { turnstile } from "@pithy-sh/turnstile/src/capability";\n' : "";
      await writeFile(
        join(workerDir, "pithy.config.ts"),
        `${imports}export default { capabilities: [${registration}] };\n`,
      );
    }
    await writeBootstrapVars(projectDir, { TURNSTILE_SITEKEY_INVISIBLE: "1x00" });
    await writeFile(join(projectDir, ".dev.vars"), "KEEP=1\nTURNSTILE_SITEKEY_VISIBLE=1x00\n");
    await linkKitPackages(projectDir, ["turnstile"]);
    return projectDir;
  }

  /** What identifies one finding across two checks. */
  const identity = (found: { file: string; name: string; environment: string }) =>
    `${found.file}\u0000${found.name}\u0000${found.environment}`;

  test("every finding that names a Worker is cleared by provisioning that Worker, and the rest say by hand", async () => {
    const projectDir = await strandedEverywhere();
    const before = await checkTurnstileSitekeys(projectDir);

    // The fixture is what the review reproduced: a var in a Worker that composes no turnstile, and one in the
    // project root's .dev.vars. Without both, the case below cannot fail on either half.
    expect(before.stranded.map((found) => [found.worker, found.file.slice(projectDir.length)])).toEqual(
      expect.arrayContaining([
        ["web", join("/apps", "web", "wrangler.jsonc")],
        [null, "/.dev.vars"],
      ]),
    );

    for (const worker of new Set(before.stranded.map((found) => found.removedBy))) {
      if (worker === null) continue;
      const { worker: target } = await resolveTurnstileTarget({ projectDir, worker });
      await new CloudflareTurnstileProvisioner({
        account: { accountId: "acct-1", confirmation: "pinned" },
        cf: {} as CloudflareClients,
        project: "acme",
        projectDir,
        workerDir: target.dir,
        dispatcher: { dispatch: async () => {} },
        environments: DEFAULT_ENVIRONMENTS,
        notes: () => {},
      }).removeStrandedSitekeyVars();
    }

    const after = new Set((await checkTurnstileSitekeys(projectDir)).stranded.map(identity));
    const promised = before.stranded.filter((found) => found.removedBy !== null);
    expect(promised.length).toBeGreaterThan(0);
    expect(promised.filter((found) => after.has(identity(found)))).toEqual([]);

    const lines = describeTurnstileSitekeys(before);
    for (const found of before.stranded.filter((each) => each.removedBy === null)) {
      const line = lines.find((each) => each.startsWith(`${found.file}:`)) ?? "";
      expect(line).toMatch(/by hand/);
      expect(line).not.toContain("pithy turnstile provision");
    }
    // The adopter's own lines in the root .dev.vars are theirs; doctor reads the file and never edits it.
    expect(await readFile(join(projectDir, ".dev.vars"), "utf8")).toContain("KEEP=1");
  });
});

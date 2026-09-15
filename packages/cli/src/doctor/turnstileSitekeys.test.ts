// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, test } from "vitest";
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

  test("a feature build is named once this Worker has one, and not before", async () => {
    const { projectDir, workerDir } = await project({ sitekeys: PROVISIONED });
    expect((await checkTurnstileSitekeys(projectDir)).unrendered).toEqual([]);

    await mkdir(join(workerDir, ".wrangler", "pithy"), { recursive: true });
    await writeFile(featureConfigPath(workerDir), "{}");

    expect((await checkTurnstileSitekeys(projectDir)).unrendered).toEqual([
      { worker: "board", environment: "feature", slot: false },
    ]);
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
      },
      {
        worker: "board",
        name: "TURNSTILE_SITEKEY_VISIBLE",
        environment: "staging",
        file: join(workerDir, "wrangler.jsonc"),
      },
      {
        worker: null,
        name: "TURNSTILE_SITEKEY_INVISIBLE",
        environment: "dev",
        file: expect.stringMatching(/dev\.json$/),
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

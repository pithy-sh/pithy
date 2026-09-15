// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PithyError } from "@pithy-sh/core/src/error/pithyError";
import { isTurnstileCapability } from "@pithy-sh/turnstile/src/capability";
import { afterAll, describe, expect, test } from "vitest";
import { allCapabilities, loadWorkerConfig } from "../project/config";
import { linkKitPackages } from "../test-utils/linkKit";
import { writeTurnstileSitekeys } from "./turnstileSitekeys";

/**
 * **The writer edits string literals in the registration, and what the config then says is the proof.**
 *
 * Every case loads the file back through the CLI's own config loader rather than grepping it: a sitekey
 * written somewhere the capability does not read — a second `turnstile(` in a comment, a sibling key, a
 * Worker var — is the #590 defect, and text search would call every one of them a pass.
 */

const dirs: string[] = [];
afterAll(async () => {
  await Promise.all(dirs.map((dir) => rm(dir, { recursive: true, force: true })));
});

/** A Worker directory holding `pithy.config.ts` verbatim, with the turnstile package installed beside it. */
async function worker(config: string): Promise<string> {
  const projectDir = await mkdtemp(join(tmpdir(), "pithy-sitekeys-"));
  dirs.push(projectDir);
  await linkKitPackages(projectDir, ["turnstile"]);
  const workerDir = join(projectDir, "apps", "board");
  await mkdir(workerDir, { recursive: true });
  await writeFile(join(workerDir, "pithy.config.ts"), config);
  return workerDir;
}

/** What the capability resolved from the file as it now stands. */
async function resolvedSitekeys(workerDir: string) {
  const config = await loadWorkerConfig(workerDir, { fresh: true });
  const capability = allCapabilities(config).find(isTurnstileCapability);
  return capability?.turnstileConfig.widgets;
}

const IMPORTS = [
  'import { turnstile } from "@pithy-sh/turnstile/src/capability";',
  'import { testSitekey } from "@pithy-sh/turnstile/src/provision/testKeys";',
].join("\n");

/** A config shaped like the one `pithy add turnstile` scaffolds, with a neighbor either side. */
function scaffolded(sitekeys = 'dev: "", staging: "", prod: ""'): string {
  return `${IMPORTS}

export default {
  capabilities: [
    // Before the registration: a comment that names turnstile( and must not be edited.
    turnstile({
      // Which widgets this project renders.
      widgets: {
        visible: {
          sitekeys: { ${sitekeys} },
        },
      },
    }),
  ],
};
`;
}

const PROVISIONED = {
  visible: { dev: "1x00000000000000000000AA", staging: "1x00000000000000000000AA", prod: "0x4AAAA_real" },
};

describe("writeTurnstileSitekeys", () => {
  test("writes every environment's literal, and the loaded config reads exactly those values", async () => {
    const dir = await worker(scaffolded());

    const written = await writeTurnstileSitekeys({ workerDir: dir, sitekeys: PROVISIONED });

    expect(written).toEqual({ path: join(dir, "pithy.config.ts"), changed: true });
    expect((await resolvedSitekeys(dir))?.visible?.sitekeys).toEqual(PROVISIONED.visible);
    // Only the three literals moved: every comment and every other byte is where it was.
    const source = await readFile(join(dir, "pithy.config.ts"), "utf8");
    expect(source).toBe(
      scaffolded('dev: "1x00000000000000000000AA", staging: "1x00000000000000000000AA", prod: "0x4AAAA_real"'),
    );
  });

  test("is idempotent: a second run over its own output changes nothing", async () => {
    const dir = await worker(scaffolded());
    await writeTurnstileSitekeys({ workerDir: dir, sitekeys: PROVISIONED });
    const first = await readFile(join(dir, "pithy.config.ts"), "utf8");

    expect(await writeTurnstileSitekeys({ workerDir: dir, sitekeys: PROVISIONED })).toMatchObject({ changed: false });
    expect(await readFile(join(dir, "pithy.config.ts"), "utf8")).toBe(first);
  });

  test("leaves an expression that already resolves to the value alone", async () => {
    // The dashboard's own shape: `dev: testSitekey("visible")`. It says the right thing, in a way a writer
    // of literals must not flatten.
    const dir = await worker(scaffolded('dev: testSitekey("visible"), staging: "", prod: ""'));

    await writeTurnstileSitekeys({ workerDir: dir, sitekeys: PROVISIONED });

    const source = await readFile(join(dir, "pithy.config.ts"), "utf8");
    expect(source).toContain('dev: testSitekey("visible")');
    expect((await resolvedSitekeys(dir))?.visible?.sitekeys).toEqual(PROVISIONED.visible);
  });

  test("refuses an expression that says something else, naming the key, and writes nothing", async () => {
    const original = scaffolded('dev: "", staging: String(""), prod: ""');
    const dir = await worker(original);

    const error = await writeTurnstileSitekeys({ workerDir: dir, sitekeys: PROVISIONED }).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(PithyError);
    expect((error as PithyError).payload.message).toContain("widgets.visible.sitekeys.staging");
    expect((error as PithyError).payload.action).toContain('"1x00000000000000000000AA"');
    // All or nothing: the two literals it could have written were not.
    expect(await readFile(join(dir, "pithy.config.ts"), "utf8")).toBe(original);
  });

  test("writes quoted keys and single-quoted values, the spellings Biome leaves alone in a hand edit", async () => {
    const dir = await worker(scaffolded(`"dev": '', 'staging': "", prod: \`\``));

    await writeTurnstileSitekeys({ workerDir: dir, sitekeys: PROVISIONED });

    expect((await resolvedSitekeys(dir))?.visible?.sitekeys).toEqual(PROVISIONED.visible);
  });

  test("a value that holds a comma or a brace does not throw the scan off the next key", async () => {
    const dir = await worker(scaffolded('dev: "a,b}", staging: "", prod: ""'));

    await writeTurnstileSitekeys({ workerDir: dir, sitekeys: PROVISIONED });

    expect((await resolvedSitekeys(dir))?.visible?.sitekeys).toEqual(PROVISIONED.visible);
  });

  test("refuses a config with no widget block for the mode, rather than inventing one", async () => {
    const original = `${IMPORTS}\nexport default { capabilities: [\n  turnstile(),\n] };\n`;
    const dir = await worker(original);

    await expect(writeTurnstileSitekeys({ workerDir: dir, sitekeys: PROVISIONED })).rejects.toMatchObject({
      payload: { message: expect.stringContaining("widgets.visible.sitekeys") },
    });
    expect(await readFile(join(dir, "pithy.config.ts"), "utf8")).toBe(original);
  });

  test("a decoy registration the capability never reads is caught by the read-back, and the file is restored", async () => {
    // The #590 shape in miniature: a writer that found *a* `turnstile(` and edited it. A line-start
    // `turnstile(` inside a template literal is one the locator matches and the loader never evaluates.
    const original = `${IMPORTS}

export const EXAMPLE = \`
turnstile({ widgets: { visible: { sitekeys: { dev: "", staging: "", prod: "" } } } })
\`;

export default {
  capabilities: [
    turnstile({
      widgets: {
        visible: {
          sitekeys: { dev: "", staging: "", prod: "" },
        },
      },
    }),
  ],
};
`;
    const dir = await worker(original);

    const error = await writeTurnstileSitekeys({ workerDir: dir, sitekeys: PROVISIONED }).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(PithyError);
    expect(await readFile(join(dir, "pithy.config.ts"), "utf8")).toBe(original);
    expect((await resolvedSitekeys(dir))?.visible?.sitekeys).toEqual({ dev: "", staging: "", prod: "" });
  });
});

// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PithyError } from "@pithy-sh/core/src/error/pithyError";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { loadProject, loadProjectPrivacy } from "../project/config";
import { declarePrivacyClasses } from "./declare";

let dir: string;

/** The refusal a call makes, for its `action` line — what an operator is told to do. */
async function refusal(run: Promise<unknown>): Promise<PithyError> {
  try {
    await run;
  } catch (error) {
    if (error instanceof PithyError) return error;
    throw error;
  }
  throw new Error("expected a refusal");
}

/** The starter's shape: a `const config = { … }` the file default-exports by name. */
const STARTER = `// pithy.config.ts — your project's identity and policy.

const config = {
  // The project name.
  name: "acme",

  // tokens: { overrides: {} },
};

export default config;
`;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "pithy-privacy-declare-"));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

async function source(): Promise<string> {
  return readFile(join(dir, "pithy.config.ts"), "utf8");
}

describe("declarePrivacyClasses", () => {
  test("writes the root config key into the starter's shape, and the loader reads it back", async () => {
    await writeFile(join(dir, "pithy.config.ts"), STARTER);
    const result = await declarePrivacyClasses({ projectDir: dir, classes: ["pii", "phi"] });
    expect(result).toMatchObject({ classes: ["pii", "phi"], changed: true });
    expect(await source()).toContain('privacy: { classes: ["pii", "phi"] },');
    expect(loadProjectPrivacy(await loadProject(dir, { fresh: true }))).toEqual(["pii", "phi"]);
  });

  test("uncomments the starter's own example in place, rather than writing a second explanation", async () => {
    const withExample = STARTER.replace(
      "  // tokens: { overrides: {} },\n",
      '  // tokens: { overrides: {} },\n\n  // The privacy classes.\n  // privacy: { classes: ["pii"] },\n',
    );
    await writeFile(join(dir, "pithy.config.ts"), withExample);
    await declarePrivacyClasses({ projectDir: dir, classes: ["phi"] });
    const text = await source();
    expect(text).toContain('  // The privacy classes.\n  privacy: { classes: ["phi"] },\n');
    expect(text.match(/privacy:/g)).toHaveLength(1);
    expect(loadProjectPrivacy(await loadProject(dir, { fresh: true }))).toEqual(["phi"]);
  });

  test("is idempotent: a re-run with the same classes writes nothing", async () => {
    await writeFile(join(dir, "pithy.config.ts"), STARTER);
    await declarePrivacyClasses({ projectDir: dir, classes: ["pii", "phi"] });
    const once = await source();
    const again = await declarePrivacyClasses({ projectDir: dir, classes: ["phi", "pii"] });
    expect(again.changed).toBe(false);
    expect(await source()).toBe(once);
  });

  test("adds to what is declared rather than replacing it", async () => {
    await writeFile(join(dir, "pithy.config.ts"), STARTER);
    await declarePrivacyClasses({ projectDir: dir, classes: ["pii"] });
    const result = await declarePrivacyClasses({ projectDir: dir, classes: ["phi"] });
    expect(result.classes).toEqual(["pii", "phi"]);
    expect(loadProjectPrivacy(await loadProject(dir, { fresh: true }))).toEqual(["pii", "phi"]);
    expect((await source()).match(/privacy:/g)).toHaveLength(1);
  });

  test("writes into `export default { … }` too, and into an object with no trailing comma", async () => {
    await writeFile(join(dir, "pithy.config.ts"), 'export default {\n  name: "acme"\n};\n');
    await declarePrivacyClasses({ projectDir: dir, classes: ["pci"] });
    expect(loadProjectPrivacy(await loadProject(dir, { fresh: true }))).toEqual(["pci"]);
  });

  test("refuses an expression it would have to flatten, naming the line to write by hand", async () => {
    await writeFile(
      join(dir, "pithy.config.ts"),
      'const classes = ["pii"];\nexport default { name: "acme", privacy: { classes } };\n',
    );
    const original = await source();
    const error = await refusal(declarePrivacyClasses({ projectDir: dir, classes: ["phi"] }));
    expect(error.payload.action).toContain('privacy: { classes: ["pii", "phi"] }');
    expect(error.payload.action).toContain("by hand");
    expect(await source()).toBe(original);
  });

  test("refuses a config whose exported object it cannot find", async () => {
    await writeFile(
      join(dir, "pithy.config.ts"),
      'export default makeConfig({ name: "acme" });\nfunction makeConfig(c: object) { return c; }\n',
    );
    const error = await refusal(declarePrivacyClasses({ projectDir: dir, classes: ["pii"] }));
    expect(error.payload.action).toContain('privacy: { classes: ["pii"] }');
  });

  test("refuses a class name that is not one", async () => {
    await writeFile(join(dir, "pithy.config.ts"), STARTER);
    await expect(declarePrivacyClasses({ projectDir: dir, classes: ["Not A Class"] })).rejects.toThrow(PithyError);
    expect(await source()).toBe(STARTER);
  });
});

// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PithyError } from "@pithy-sh/core/src/error/pithyError";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { DEFAULT_WORKER, scaffoldProject } from "../project/scaffold";
import { fixOf } from "../terminal/exitClass";
import { type ConfigPrompt, runAdd } from "./flow";
import { authDatabase, composesOAuthProvider, mcpConfigValues, mcpPromptOptions } from "./mcpAdd";

const MCP_MANIFEST = new URL("../../../auth/pithy.mcp.manifest.json", import.meta.url);

/** A config holding one auth registration, written the way a reader of the source sees it. */
function configWith(registration: string, imports = ""): string {
  return `${imports}import { auth } from "@pithy-sh/auth/src/index";
const config = {
  capabilities: [
    ${registration}
    // pithy:capabilities (managed region — do not remove this marker)
  ],
};
export default config;
`;
}

describe("authDatabase", () => {
  test.each([
    ["auth(),", { known: true, binding: "DB" }],
    ['auth({ basePath: "/auth" }),', { known: true, binding: "DB" }],
    ['auth({ database: "APP_DB" }),', { known: true, binding: "APP_DB" }],
    ["auth({ database: 'APP_DB' }),", { known: true, binding: "APP_DB" }],
    ["auth({ database: APP_DB }),", { known: false }],
    ["auth({ ...shared }),", { known: false }],
    ["auth(authOptions),", { known: false }],
  ])("reads %s", (registration, expected) => {
    expect(authDatabase(configWith(registration))).toEqual(expected);
  });
});

describe("mcpPromptOptions", () => {
  const options = [
    { key: "floor", describe: "The floor." },
    { key: "database", describe: "The database.", default: "DB" },
    { key: "path", describe: "The path.", default: "/mcp" },
  ];

  test("leaves database out when auth's registration names it", () => {
    expect(mcpPromptOptions(configWith('auth({ database: "APP_DB" }),'), options).map((one) => one.key)).toEqual([
      "floor",
      "path",
    ]);
    expect(mcpPromptOptions(configWith("auth(),"), options).map((one) => one.key)).toEqual(["floor", "path"]);
  });

  test("keeps database when auth's registration does not name it as a string", () => {
    expect(mcpPromptOptions(configWith("auth(authOptions),"), options)).toEqual(options);
  });
});

describe("composesOAuthProvider", () => {
  test("is true for an import of the provider, or a call to it in auth's registration", () => {
    expect(
      composesOAuthProvider(configWith("auth(),", 'import { oauthProvider } from "@better-auth/oauth-provider";\n')),
    ).toBe(true);
    expect(composesOAuthProvider(configWith("auth({ plugins: [oauthProvider({})] }),"))).toBe(true);
    expect(composesOAuthProvider(configWith("auth({ plugins: [apiKey()] }),"))).toBe(false);
    expect(composesOAuthProvider(configWith("auth(),"))).toBe(false);
  });
});

describe("mcpConfigValues", () => {
  const again = "pithy add mcp --worker api";

  test("takes auth's database over the manifest's default", () => {
    expect(
      mcpConfigValues({ source: configWith('auth({ database: "APP_DB" }),'), values: { floor: "signed-in" }, again }),
    ).toEqual({ floor: "signed-in", database: "APP_DB" });
  });

  test("refuses a --set database that differs from auth's, naming auth's", () => {
    const run = () =>
      mcpConfigValues({ source: configWith("auth(),"), values: { floor: "signed-in", database: "OTHER" }, again });
    expect(run).toThrow(PithyError);
    expect(run).toThrow(/auth uses DB/);
  });

  test("asks for --set database when auth's registration does not name it as a string", () => {
    let caught: unknown;
    try {
      mcpConfigValues({ source: configWith("auth({ database: D }),"), values: {}, again });
    } catch (thrown) {
      caught = thrown;
    }
    expect((caught as PithyError).payload).toMatchObject({ code: "input/required", flag: "--set" });
    expect((caught as PithyError).payload.action).toContain("--set database=");
    expect(
      mcpConfigValues({ source: configWith("auth({ database: D }),"), values: { database: "APP_DB" }, again }),
    ).toEqual({ database: "APP_DB" });
  });
});

describe("pithy add mcp", () => {
  let dir: string;
  let worker: string;
  let config: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "pithy-mcp-add-"));
    await scaffoldProject({ targetDir: dir, appName: "mcp-test" });
    worker = join(dir, "apps", DEFAULT_WORKER);
    config = join(worker, "pithy.config.ts");
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  /** `@pithy-sh/auth` as installed: auth's manifest, binding-free and peerless here, and mcp's real one beside it. */
  const install = async ({ projectDir, pkg }: { projectDir: string; pkg: string }) => {
    expect(pkg).toBe("@pithy-sh/auth");
    const pkgDir = join(projectDir, "node_modules", "@pithy-sh", "auth");
    await mkdir(pkgDir, { recursive: true });
    await writeFile(
      join(pkgDir, "pithy.manifest.json"),
      JSON.stringify({ name: "auth", package: "@pithy-sh/auth", requiredBindings: [] }),
    );
    await copyFile(MCP_MANIFEST, join(pkgDir, "pithy.mcp.manifest.json"));
    return { packageManager: "bun" };
  };

  const add = (
    capability: string,
    extra: { setFlags?: string[]; withPrerequisites?: boolean; prompt?: ConfigPrompt } = {},
  ) =>
    runAdd({
      account: null,
      projectDir: dir,
      workerDir: worker,
      project: "acme",
      capability,
      install,
      declare: async () => [],
      migrate: async () => [],
      bootstrap: async () => [],
      ...extra,
    });

  const refusal = (promise: Promise<unknown>) =>
    promise.then(
      () => {
        throw new Error("expected the add to be refused");
      },
      (thrown: unknown) => {
        expect(thrown).toBeInstanceOf(PithyError);
        return thrown as PithyError;
      },
    );

  test.each([
    ["signed-in", 'floor: "signed-in",'],
    ["power:agents:use", 'floor: { power: "agents:use" },'],
    ["entitlement:pro", 'floor: { entitlement: "pro" },'],
  ])("--floor %s writes mcp({ floor }) beside auth() with auth's database", async (floor, line) => {
    await add("auth");
    await add("mcp", { setFlags: [`floor=${floor}`] });

    const source = await readFile(config, "utf8");
    expect(source).toContain('import { mcp } from "@pithy-sh/auth/src/index";');
    const registration = source.slice(source.indexOf("mcp({"), source.indexOf("})", source.indexOf("mcp({")));
    expect(source.indexOf("auth()")).toBeLessThan(source.indexOf("mcp({"));
    expect(registration).toContain(line);
    expect(registration).toContain('database: "DB",');
    expect(registration).toContain('path: "/mcp",');
  });

  test("writes the database auth names", async () => {
    await add("auth");
    await writeFile(config, (await readFile(config, "utf8")).replace("auth(),", 'auth({ database: "APP_DB" }),'));
    await add("mcp", { setFlags: ["floor=signed-in"] });
    expect(await readFile(config, "utf8")).toContain('database: "APP_DB",');
  });

  test("asks a person nothing about database, and writes the one auth names", async () => {
    await add("auth");
    await writeFile(config, (await readFile(config, "utf8")).replace("auth(),", 'auth({ database: "AUTH_DB" }),'));
    const asked: string[] = [];
    // A person pressing enter at every question: each option not yet settled takes its default.
    const prompt: ConfigPrompt = async (manifest, provided) => {
      const values = { ...provided };
      for (const option of manifest.configOptions) {
        if (option.key in values || typeof option.default === "object" || option.default === undefined) continue;
        asked.push(option.key);
        values[option.key] = option.default;
      }
      return values;
    };
    const result = await add("mcp", { setFlags: ["floor=signed-in"], prompt });
    expect(asked).not.toContain("database");
    expect(await readFile(config, "utf8")).toContain('database: "AUTH_DB",');
    expect(JSON.stringify(result)).not.toContain("database=DB");
  });

  test("refuses mcp when auth is registered from a variable and --set database is absent", async () => {
    await add("auth");
    await writeFile(
      config,
      (await readFile(config, "utf8"))
        .replace("const config", 'const authOptions = { database: "AUTH_DB" };\nconst config')
        .replace("auth(),", "auth(authOptions),"),
    );
    const error = await refusal(add("mcp", { setFlags: ["floor=signed-in"] }));
    expect(error.payload).toMatchObject({ code: "input/required", flag: "--set" });
    expect(error.payload.action).toContain("--set database=");
    expect(await readFile(config, "utf8")).not.toMatch(/^\s*mcp\(/m);
  });

  test("refuses without auth composed, naming pithy add auth", async () => {
    const error = await refusal(add("mcp", { setFlags: ["floor=signed-in"] }));
    expect(error.payload).toMatchObject({ code: "input/required", flag: "--with-prerequisites" });
    expect(error.payload.action).toContain(`pithy add auth --worker ${DEFAULT_WORKER}`);
    expect(await readFile(config, "utf8")).not.toMatch(/^\s*mcp\(/m);
  });

  test("refuses without --floor, naming every floor and what each admits", async () => {
    await add("auth");
    const error = await refusal(add("mcp"));
    expect(error.payload).toMatchObject({
      code: "input/required",
      flag: "--floor",
      choices: ["signed-in", "power:<name>", "entitlement:<name>"],
    });
    const action = error.payload.action ?? "";
    expect(action).toContain("--floor signed-in, --floor power:<name> or --floor entitlement:<name>");
    expect(action).toContain("Every signed-in user may connect an agent.");
    expect(await readFile(config, "utf8")).not.toMatch(/^\s*mcp\(/m);
  });

  test("refuses a floor outside the three spellings", async () => {
    await add("auth");
    const error = await refusal(add("mcp", { setFlags: ["floor=everyone"] }));
    expect(error.payload.action).toContain("--floor power:<name>");
  });

  test("refuses when auth already composes an OAuth provider, naming the fix", async () => {
    await add("auth");
    const source = await readFile(config, "utf8");
    await writeFile(
      config,
      `import { oauthProvider } from "@better-auth/oauth-provider";\n${source.replace("auth(),", "auth({ plugins: [oauthProvider({})] }),")}`,
    );
    const error = await refusal(add("mcp", { setFlags: ["floor=signed-in"] }));
    expect(error.payload.code).toBe("core/conflict");
    expect(error.payload.action).toContain("Remove oauthProvider()");
    expect(fixOf(error)).toBeUndefined();
    expect(await readFile(config, "utf8")).not.toMatch(/^\s*mcp\(/m);
  });

  test("names what follows: pithy ui add, and the describeRoute tool fields", async () => {
    await add("auth");
    const { notes } = await add("mcp", { setFlags: ["floor=power:agents"] });
    expect(notes.join("\n")).toContain("pithy ui add");
    expect(notes.join("\n")).toContain("describeRoute({ operation, tool: true })");
    expect(notes.join("\n")).toContain("tool: { effect }");
  });

  test("a second run changes nothing", async () => {
    await add("auth");
    await add("mcp", { setFlags: ["floor=signed-in"] });
    const once = await readFile(config, "utf8");
    await add("mcp");
    expect(await readFile(config, "utf8")).toBe(once);
  });
});

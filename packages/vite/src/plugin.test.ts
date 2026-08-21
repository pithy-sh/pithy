// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PithyError } from "@pithy-sh/core/src/error/pithyError";
import { build, type EnvironmentModuleNode, type ResolvedConfig } from "vite";
import { afterAll, describe, expect, test } from "vitest";
import { type PithyPlugin, pithy } from "./plugin";

const dirs: string[] = [];

afterAll(async () => {
  await Promise.all(dirs.map((dir) => rm(dir, { recursive: true, force: true })));
});

/** A scratch worker directory. Files are written verbatim, so each test states its own fixture. */
async function workerDir(files: Record<string, string>): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "pithy-vite-"));
  dirs.push(dir);
  for (const [name, content] of Object.entries(files)) {
    await writeFile(join(dir, name), content, "utf8");
  }
  return dir;
}

/**
 * A `pithy.config.ts` that records every evaluation in `loads.log`. Counting that file is how the
 * tests observe whether the plugin loaded the config once or once per virtual module.
 */
function configSource(dir: string, body: string): string {
  return [
    'import { appendFileSync } from "node:fs";',
    `appendFileSync(${JSON.stringify(join(dir, "loads.log"))}, "load\\n");`,
    body,
  ].join("\n");
}

async function loadCount(dir: string): Promise<number> {
  try {
    const log = await readFile(join(dir, "loads.log"), "utf8");
    return log.split("\n").filter((line) => line.length > 0).length;
  } catch {
    return 0;
  }
}

/**
 * Drive the plugin's hooks the way Vite does.
 *
 * The hooks are plain functions on the returned object, and `PithyPlugin` names none of them (#414) —
 * the whole point of that type is that it says nothing an adopter's checker has to compare against
 * their copy of Vite. So the shape a test drives is stated once here rather than at every call. It is
 * not a weaker check than reading the hooks off `Plugin` was: the signatures below are the ones every
 * case in this file calls, and `plugin.ts` is what holds them to Vite's — `satisfies Plugin`, in the
 * program where the kit's own Vite is the right one.
 */
function driver(plugin: PithyPlugin, root: string) {
  const hooks = plugin as unknown as {
    configResolved: (config: ResolvedConfig) => void;
    configureServer: (server: { watcher: { add: (path: string) => void } }) => void;
    resolveId: (id: string) => string | null;
    load: (id: string) => Promise<string | null>;
    hotUpdate: (this: unknown, options: { file: string }) => EnvironmentModuleNode[] | undefined;
  };
  hooks.configResolved({ root } as ResolvedConfig);
  return {
    resolveId: (id: string) => hooks.resolveId(id),
    configureServer: hooks.configureServer,
    hotUpdate: hooks.hotUpdate,
    /** Resolve then load, exactly as Vite would — the pair is what a real import goes through. */
    async loadCapability(name: string): Promise<string> {
      const resolved = hooks.resolveId(`virtual:pithy/${name}`);
      expect(resolved).toBe(`\0virtual:pithy/${name}`);
      const code = await hooks.load(resolved as string);
      expect(code).not.toBeNull();
      return code as string;
    },
  };
}

/** Read a rendered virtual module's default export back, so tests assert on values, not on source text. */
function defaultExport(code: string): Record<string, unknown> {
  const match = /^export default (.*);$/m.exec(code);
  expect(match).not.toBeNull();
  return JSON.parse((match as RegExpExecArray)[1] as string) as Record<string, unknown>;
}

const AUTH_CONFIG = `
export default {
  capabilities: [
    {
      name: "auth",
      requiredBindings: [],
      client: (context) => ({
        enabled: true,
        otpLength: 6,
        providers: ["magic-link", "otp"],
        baseUrl: context.environment === "production" ? "https://acme.com" : "http://localhost:8787",
      }),
    },
    { name: "ledger", requiredBindings: [] },
  ],
  app: {
    name: "api",
    requiredBindings: [],
    client: () => ({ enabled: true, version: "1.0.0" }),
  },
};
`;

describe("pithy() virtual modules", () => {
  test("a composed capability's projection reaches the module, as default and named exports", async () => {
    const dir = await workerDir({ "pithy.config.ts": AUTH_CONFIG });
    const code = await driver(pithy(), dir).loadCapability("auth");

    expect(code).toContain("export const enabled = true;");
    expect(code).toContain("export const otpLength = 6;");
    expect(code).toContain('export const providers = ["magic-link","otp"];');
    expect(defaultExport(code)).toEqual({
      enabled: true,
      otpLength: 6,
      providers: ["magic-link", "otp"],
      baseUrl: "http://localhost:8787",
    });
  });

  test("the app capability projects alongside the libraries", async () => {
    const dir = await workerDir({ "pithy.config.ts": AUTH_CONFIG });
    const code = await driver(pithy(), dir).loadCapability("api");
    expect(defaultExport(code)).toEqual({ enabled: true, version: "1.0.0" });
  });

  test("a composed capability with no client projection is disabled, not an error", async () => {
    const dir = await workerDir({ "pithy.config.ts": AUTH_CONFIG });
    const code = await driver(pithy(), dir).loadCapability("ledger");
    expect(defaultExport(code)).toEqual({ enabled: false });
  });

  test("an uncomposed capability resolves to { enabled: false }", async () => {
    const dir = await workerDir({ "pithy.config.ts": AUTH_CONFIG });
    const code = await driver(pithy(), dir).loadCapability("leaderboard");
    expect(code).toContain("export const enabled = false;");
    expect(defaultExport(code)).toEqual({ enabled: false });
  });

  test("a capability name nobody has heard of resolves to { enabled: false }", async () => {
    const dir = await workerDir({ "pithy.config.ts": AUTH_CONFIG });
    const code = await driver(pithy(), dir).loadCapability("telepathy");
    expect(defaultExport(code)).toEqual({ enabled: false });
  });

  test("resolveId declines anything that is not a Pithy virtual module", async () => {
    const dir = await workerDir({ "pithy.config.ts": AUTH_CONFIG });
    const hooks = driver(pithy(), dir);
    expect(hooks.resolveId("react")).toBeNull();
    expect(hooks.resolveId("./routes/pithy/signIn.tsx")).toBeNull();
    expect(hooks.resolveId("virtual:pithy/")).toBeNull();
  });

  test("the environment threads through to the projection", async () => {
    const dir = await workerDir({ "pithy.config.ts": AUTH_CONFIG });
    const dev = defaultExport(await driver(pithy({ environment: "dev" }), dir).loadCapability("auth"));
    const production = defaultExport(await driver(pithy({ environment: "production" }), dir).loadCapability("auth"));
    expect(dev.baseUrl).toBe("http://localhost:8787");
    expect(production.baseUrl).toBe("https://acme.com");
  });

  test("a non-JSON projection value fails the build instead of being inlined", async () => {
    const dir = await workerDir({
      "pithy.config.ts": `
        export default {
          capabilities: [
            { name: "auth", requiredBindings: [], client: () => ({ enabled: true, since: new Date(0) }) },
          ],
        };
      `,
    });
    const hooks = driver(pithy(), dir);
    await expect(hooks.loadCapability("auth")).rejects.toThrow(PithyError);
    await expect(hooks.loadCapability("auth")).rejects.toThrow(/client projection is not JSON/);
  });

  test("a missing pithy.config.ts is an actionable PithyError, not a stack", async () => {
    const dir = await workerDir({});
    const error = await driver(pithy(), dir)
      .loadCapability("auth")
      .catch((cause: unknown) => cause);
    expect(error).toBeInstanceOf(PithyError);
    expect((error as PithyError).payload.code).toBe("core/not_found");
    expect((error as PithyError).payload.message).toContain("pithy.config.ts");
    expect((error as PithyError).payload.action).toContain("pithy ui add");
  });

  test("a config that does not default-export a worker config is an actionable PithyError", async () => {
    const dir = await workerDir({ "pithy.config.ts": "export default { name: 'acme' };" });
    const error = await driver(pithy(), dir)
      .loadCapability("auth")
      .catch((cause: unknown) => cause);
    expect(error).toBeInstanceOf(PithyError);
    expect((error as PithyError).payload.action).toBe("Export default { capabilities, app }.");
  });

  test("the memoized promise means one config load per build, however many modules import it", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pithy-vite-"));
    dirs.push(dir);
    await writeFile(join(dir, "pithy.config.ts"), configSource(dir, AUTH_CONFIG), "utf8");

    const hooks = driver(pithy(), dir);
    await Promise.all(["auth", "ledger", "leaderboard", "api"].map((name) => hooks.loadCapability(name)));
    expect(await loadCount(dir)).toBe(1);
  });
});

describe("pithy() watch and HMR", () => {
  test("the config and its transitive imports are watched", async () => {
    const dir = await workerDir({
      "pithy.config.ts": 'import { capabilities } from "./capabilities";\nexport default { capabilities };',
      "capabilities.ts":
        'export const capabilities = [{ name: "auth", requiredBindings: [], client: () => ({ enabled: true }) }];',
    });
    const added: string[] = [];
    const hooks = driver(pithy(), dir);
    hooks.configureServer({ watcher: { add: (path: string) => added.push(path) } });

    expect(added).toContain(join(dir, "pithy.config.ts"));
    await hooks.loadCapability("auth");
    expect(added).toContain(join(dir, "pithy.config.ts"));
    expect(added.some((path) => path.endsWith("capabilities.ts"))).toBe(true);
  });

  test("editing the config drops the memo, invalidates the virtual modules, and reloads", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pithy-vite-"));
    dirs.push(dir);
    const configFile = join(dir, "pithy.config.ts");
    await writeFile(configFile, configSource(dir, AUTH_CONFIG), "utf8");

    const hooks = driver(pithy(), dir);
    hooks.configureServer({ watcher: { add: () => undefined } });
    await hooks.loadCapability("auth");
    expect(await loadCount(dir)).toBe(1);

    const authModule = { id: "\0virtual:pithy/auth" } as EnvironmentModuleNode;
    const clientModule = { id: "/src/client.tsx" } as EnvironmentModuleNode;
    const invalidated: EnvironmentModuleNode[] = [];
    const sent: { type: string }[] = [];
    const environment = {
      environment: {
        moduleGraph: {
          idToModuleMap: new Map([
            [authModule.id, authModule],
            [clientModule.id, clientModule],
          ]),
          invalidateModule: (module: EnvironmentModuleNode) => invalidated.push(module),
        },
        hot: { send: (payload: { type: string }) => sent.push(payload) },
      },
    };

    const returned = hooks.hotUpdate.call(environment, { file: configFile });
    expect(invalidated).toEqual([authModule]);
    expect(returned).toEqual([authModule]);
    expect(sent).toEqual([{ type: "full-reload" }]);

    await hooks.loadCapability("auth");
    expect(await loadCount(dir)).toBe(2);
  });

  test("an unrelated file change is ignored", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pithy-vite-"));
    dirs.push(dir);
    await writeFile(join(dir, "pithy.config.ts"), configSource(dir, AUTH_CONFIG), "utf8");

    const hooks = driver(pithy(), dir);
    await hooks.loadCapability("auth");
    const sent: { type: string }[] = [];
    const environment = {
      environment: {
        moduleGraph: { idToModuleMap: new Map(), invalidateModule: () => undefined },
        hot: { send: (payload: { type: string }) => sent.push(payload) },
      },
    };

    expect(hooks.hotUpdate.call(environment, { file: join(dir, "src", "client.tsx") })).toBeUndefined();
    expect(sent).toEqual([]);
    await hooks.loadCapability("auth");
    expect(await loadCount(dir)).toBe(1);
  });
});

describe("pithy() through a real vite build", () => {
  test("the projection is inlined and unprojected config never reaches the bundle", async () => {
    const dir = await workerDir({
      "pithy.config.ts": `
        const SECRET = "sk_test_never_ship_this";
        export default {
          capabilities: [
            {
              name: "auth",
              requiredBindings: [],
              secret: SECRET,
              client: (context) => ({
                enabled: true,
                otpLength: 6,
                turnstileSitekey: context.environment === "production" ? "0x4AAA_prod" : "0x4AAA_dev",
              }),
            },
          ],
        };
      `,
      "entry.ts": [
        'import auth from "virtual:pithy/auth";',
        'import ledger from "virtual:pithy/ledger";',
        'import { otpLength } from "virtual:pithy/auth";',
        "export const screen = { auth, ledger, otpLength };",
      ].join("\n"),
    });

    const bundle = await build({
      root: dir,
      configFile: false,
      logLevel: "silent",
      plugins: [pithy({ environment: "production" })],
      build: {
        write: false,
        minify: false,
        lib: { entry: "entry.ts", formats: ["es"], fileName: "entry" },
      },
    });
    const outputs = (Array.isArray(bundle) ? bundle : [bundle]) as unknown as {
      output: { type: string; code?: string }[];
    }[];
    const code = outputs
      .flatMap((result) => result.output)
      .filter((chunk) => chunk.type === "chunk")
      .map((chunk) => chunk.code ?? "")
      .join("\n");

    expect(code).toContain("0x4AAA_prod");
    expect(code).toMatch(/"?otpLength"?:\s*6/);
    // The environment threaded through the build: the dev sitekey was never a candidate.
    expect(code).not.toContain("0x4AAA_dev");
    // The security boundary: a config value the capability did not project is not in the bundle.
    expect(code).not.toContain("sk_test_never_ship_this");
    // An uncomposed capability still bundles, disabled — the screen branches rather than breaking.
    expect(code).toMatch(/"?enabled"?:\s*false/);
  }, 60_000);
});

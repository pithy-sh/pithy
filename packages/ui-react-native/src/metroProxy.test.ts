// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage, request, type Server, type ServerResponse } from "node:http";
import { createRequire } from "node:module";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MCP_BASE_PATH } from "@pithy-sh/auth/src/client/mcp";
import { CONSENT_BASE_PATH } from "@pithy-sh/consent/src/client/api";
import { envStem, originVarName } from "@pithy-sh/core/src/env/stem";
import { HEALTH_PATH } from "@pithy-sh/core/src/worker/health";
import { ORGANIZATION_BASE_PATH } from "@pithy-sh/organization/src/client/api";
import { TURNSTILE_WIDGET_PATH } from "@pithy-sh/turnstile/src/http/widgetPage";
import { afterEach, describe, expect, test } from "vitest";
import {
  GENERATED_CONFIG_PATH,
  type GeneratedConfig,
  readGeneratedConfig,
  renderGeneratedConfig,
} from "./generatedConfig";
import { TEMPLATE_DIR, TEMPLATE_GROUPS } from "./templates";

type Next = () => void;
type Middleware = (req: IncomingMessage, res: ServerResponse, next: Next) => void;

/** `templates/metro-proxy.cjs`, as `metro.config.js` requires it. */
interface MetroProxy {
  KIT_PATHS: { organization: string; consent: string; mcp: string; health: string; turnstile: string };
  readGeneratedConfig(text: string): GeneratedConfig | null;
  proxiedPaths(config: GeneratedConfig): string[];
  isProxied(url: string, paths: readonly string[]): boolean;
  createDevProxy(input: { target: string; paths: readonly string[] }): Middleware;
  envStem(name: string): string;
  workerOriginVar(appDir: string): string | null;
  exportedOrigin(appDir: string, env: Record<string, string | undefined>): string | null;
  devTarget(generated: GeneratedConfig, appDir: string, env: Record<string, string | undefined>): string;
  withDevProxy<T extends { server?: Record<string, unknown> }>(
    config: T,
    appDir: string,
    warn?: (message: string) => void,
    env?: Record<string, string | undefined>,
  ): T & { server: { enhanceMiddleware?: (middleware: Middleware, server: unknown) => Middleware } };
}

const load = createRequire(import.meta.url);
const proxy = load(join(TEMPLATE_DIR, "metro-proxy.cjs")) as MetroProxy;

const composed: GeneratedConfig = {
  origins: { dev: "http://localhost:8787", staging: null, prod: null },
  appScheme: "demo",
  universalLinkOrigin: null,
  rails: { ios: "apple", android: "google", web: "stripe" },
  google: { webClientId: null, iosClientId: null },
  auth: { dev: { enabled: true, basePath: "/api/auth", otpLength: 6 } },
  i18n: { dev: { enabled: false } },
  payments: { dev: { enabled: true, basePath: "/billing" } },
  turnstile: { dev: { enabled: false } },
  consent: { dev: { enabled: false } },
};

const servers: Server[] = [];
const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(
    servers.splice(0).map((server) => {
      server.closeAllConnections();
      return new Promise((done) => server.close(done));
    }),
  );
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function listen(handler: (req: IncomingMessage, res: ServerResponse) => void): Promise<string> {
  const server = createServer(handler);
  servers.push(server);
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

/** What the Worker stand-in saw. */
interface Seen {
  method?: string;
  url?: string;
  headers?: IncomingMessage["headers"];
  body?: string;
}

/** A Worker stand-in that records the request and answers 201 with two cookies. */
async function worker(seen: Seen[]): Promise<string> {
  return listen((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      seen.push({ method: req.method, url: req.url, headers: req.headers, body: Buffer.concat(chunks).toString() });
      res.writeHead(201, [
        "Content-Type",
        "application/json",
        "Set-Cookie",
        "better-auth.session_token=abc; Path=/; HttpOnly",
        "Set-Cookie",
        "pithy.acting=org_1; Path=/",
      ]);
      res.end('{"ok":true}');
    });
  });
}

/** A Metro stand-in: the proxy first, then Metro's own middleware, which answers whatever reaches it. */
async function metro(middleware: Middleware): Promise<string> {
  return listen((req, res) =>
    middleware(req, res, () => {
      res.writeHead(404);
      res.end("next");
    }),
  );
}

const metroOwn: Middleware = (_req, res) => {
  res.writeHead(200, { "content-type": "text/plain" });
  res.end("metro");
};

describe("the paths the web build's dev proxy sends to the Worker", () => {
  test("each composed capability's base path, the kit's fixed ones, and the OAuth discovery documents", () => {
    expect(proxy.proxiedPaths(composed).sort()).toEqual(
      [
        "/api/auth",
        "/billing",
        "/organizations",
        "/consent",
        "/mcp",
        "/health",
        "/.well-known/oauth-authorization-server",
        "/.well-known/oauth-protected-resource",
      ].sort(),
    );
  });

  test("the base paths the generated config lists are the ones proxied, wherever a capability is mounted", () => {
    const listed = { ...composed, workerPaths: ["/api/auth", "/health", "/privacy", "/teams"] };
    const paths = proxy.proxiedPaths(listed);
    expect(paths).toEqual(["/api/auth", "/health", "/privacy", "/teams"]);
    expect(proxy.isProxied("/teams/acme/members", paths)).toBe(true);
    expect(proxy.isProxied("/privacy/purposes", paths)).toBe(true);
    expect(proxy.isProxied("/organizations", paths)).toBe(false);
  });

  test("a capability the Worker does not compose has no path to proxy", () => {
    const bare = { ...composed, auth: { dev: { enabled: false } }, payments: { dev: { enabled: false } } };
    const paths = proxy.proxiedPaths(bare);
    expect(paths).not.toContain("/api/auth");
    expect(paths).not.toContain("/billing");
    expect(paths).not.toContain("/.well-known/oauth-authorization-server");
  });

  test("turnstile's widget page rides along when turnstile is on", () => {
    const withTurnstile = {
      ...composed,
      turnstile: {
        dev: { enabled: true, sitekey: "k", mode: "visible", action: "login", token: { field: "f", header: null } },
      },
    };
    expect(proxy.proxiedPaths(withTurnstile)).toContain("/turnstile");
  });

  test("consent's routes are proxied where the Worker mounted them, and the screen's own path stays with Metro", () => {
    const privacy = { ...composed, consent: { dev: { enabled: true, basePath: "/privacy" } } };
    const paths = proxy.proxiedPaths(privacy);
    expect(paths).toContain("/privacy");
    expect(paths).not.toContain("/consent");
    expect(proxy.isProxied("/privacy/me", paths)).toBe(true);
  });

  test("the dev proxy reads each capability's dev projection, the one `pithy dev` serves", () => {
    const keyed = {
      ...composed,
      payments: { dev: { enabled: true, basePath: "/billing" }, prod: { enabled: true, basePath: "/pay" } },
    };
    const paths = proxy.proxiedPaths(keyed);
    expect(paths).toContain("/billing");
    expect(paths).not.toContain("/pay");
  });

  test("the kit's fixed paths are the ones the clients call", () => {
    expect(proxy.KIT_PATHS).toEqual({
      organization: ORGANIZATION_BASE_PATH,
      consent: CONSENT_BASE_PATH,
      mcp: MCP_BASE_PATH,
      health: HEALTH_PATH,
      turnstile: `/${TURNSTILE_WIDGET_PATH.split("/")[1]}`,
    });
  });

  test("a base path matches itself and what is under it, and nothing that only starts with its letters", () => {
    const paths = proxy.proxiedPaths(composed);
    expect(proxy.isProxied("/api/auth/sign-in/email", paths)).toBe(true);
    expect(proxy.isProxied("/api/auth", paths)).toBe(true);
    expect(proxy.isProxied("/api/auth?x=1", paths)).toBe(true);
    expect(proxy.isProxied("/organizations", paths)).toBe(true);
    expect(proxy.isProxied("/consent/me", paths)).toBe(true);
    expect(proxy.isProxied("/api/authors", paths)).toBe(false);
    expect(proxy.isProxied("/", paths)).toBe(false);
    expect(proxy.isProxied("/index.bundle?platform=web", paths)).toBe(false);
    expect(proxy.isProxied("/_expo/static/js/web/entry.js", paths)).toBe(false);
  });

  test("a path that leaves its base path once the Worker resolves it is not proxied", () => {
    const paths = proxy.proxiedPaths(composed);
    expect(proxy.isProxied("/api/auth/../../internal", paths)).toBe(false);
    expect(proxy.isProxied("/api/auth/%2e%2e/%2E%2E/internal", paths)).toBe(false);
    expect(proxy.isProxied("/api/auth/..\\..\\internal", paths)).toBe(false);
    expect(proxy.isProxied("/organizations/..", paths)).toBe(false);
    expect(proxy.isProxied("/api/auth/./session", paths)).toBe(true);
  });

  test("a request target naming another host is never proxied, whatever its path", () => {
    const paths = proxy.proxiedPaths(composed);
    expect(proxy.isProxied("http://elsewhere.example/api/auth/session", paths)).toBe(false);
    expect(proxy.isProxied("//elsewhere.example/api/auth/session", paths)).toBe(false);
    expect(proxy.isProxied("/\\elsewhere.example/api/auth/session", paths)).toBe(false);
    expect(proxy.isProxied("elsewhere.example:443", paths)).toBe(false);
  });

  test("no screen the app routes to is proxied, even one named like a base path", async () => {
    const paths = proxy.proxiedPaths(composed);
    const screens = Object.values(TEMPLATE_GROUPS)
      .flat()
      .filter((file) => file.startsWith("src/routes/"));
    const routes = await readdir(join(TEMPLATE_DIR, "src/routes/app"));
    const files = [...screens, ...routes.map((name) => `src/routes/app/${name}`)];
    let checked = 0;
    for (const file of files) {
      const found = /export const path = "([^"]+)"/.exec(await readFile(join(TEMPLATE_DIR, file), "utf8"));
      if (found?.[1] === undefined) continue;
      checked += 1;
      const page = found[1].replace(/:[^/]+/g, "x");
      expect(proxy.isProxied(page, paths), page).toBe(false);
      expect(proxy.isProxied(`${page}?from=link`, paths), page).toBe(false);
    }
    expect(checked).toBeGreaterThan(10);
  });
});

describe("reading the generated config without TypeScript", () => {
  test("reads what the kit writes", () => {
    expect(proxy.readGeneratedConfig(renderGeneratedConfig(composed, "api"))).toEqual(composed);
  });

  test("reads the template the scaffold copies", async () => {
    const text = await readFile(join(TEMPLATE_DIR, GENERATED_CONFIG_PATH), "utf8");
    expect(proxy.readGeneratedConfig(text)?.origins.dev).toBe("http://localhost:8787");
  });

  test("a file it did not write is null", () => {
    expect(proxy.readGeneratedConfig("export default {};\n")).toBeNull();
    expect(proxy.readGeneratedConfig(renderGeneratedConfig(composed, "api").replace("dev: ", "dev, "))).toBeNull();
  });

  test("reads every file the kit's own reader reads, and refuses every one it refuses", () => {
    const rendered = renderGeneratedConfig(composed, "api");
    const literal = (value: string) => rendered.replace(/= \{[\s\S]*\};\n/, `= ${value};\n`);
    const corpus = [
      rendered,
      literal(JSON.stringify(composed, null, 2)),
      literal(`{
  // Where the Worker answers.
  origins: { 'dev': 'http://localhost:8787', "staging": null, prod: null, },
  appScheme: 'demo', /* the app's own */
  universalLinkOrigin: null,
  rails: { ios: "apple", android: 'google', web: "stripe" },
  google: { webClientId: null, iosClientId: null },
  auth: { dev: { enabled: true, basePath: "/api/auth", otpLength: 6, note: 'it\\'s "here"' } },
  i18n: { dev: { enabled: false } },
  payments: { dev: { enabled: true, basePath: "/billing" } },
  turnstile: { dev: { enabled: false } },
  consent: { dev: { enabled: false } },
}`),
      literal("{ ...base }"),
      literal("{ origins: process.env.ORIGINS }"),
      literal("{ appScheme: `demo` }"),
      "export default {};\n",
    ];
    for (const text of corpus) {
      const ours = readGeneratedConfig(text);
      const theirs = proxy.readGeneratedConfig(text);
      expect(theirs === null, text).toBe(ours === null);
      if (ours !== null) expect(theirs, text).toEqual(ours);
    }
  });
});

describe("the dev proxy", () => {
  test("forwards method, path, headers and body as they came, and nothing else", async () => {
    const seen: Seen[] = [];
    const target = await worker(seen);
    const front = await metro(proxy.createDevProxy({ target, paths: ["/api/auth"] }));
    const response = await fetch(`${front}/api/auth/sign-in/email?redirect=%2F`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie: "a=1", origin: front, "x-pithy-device-id": "d1" },
      body: '{"email":"a@example.com"}',
    });
    expect(seen).toHaveLength(1);
    const [request] = seen;
    expect(request?.method).toBe("POST");
    expect(request?.url).toBe("/api/auth/sign-in/email?redirect=%2F");
    expect(request?.body).toBe('{"email":"a@example.com"}');
    expect(request?.headers?.["content-type"]).toBe("application/json");
    expect(request?.headers?.cookie).toBe("a=1");
    expect(request?.headers?.origin).toBe(front);
    expect(request?.headers?.["x-pithy-device-id"]).toBe("d1");
    // The page's own host, so the Worker sees the request as same-origin with the page that sent it.
    expect(request?.headers?.host).toBe(new URL(front).host);
    await response.text();
  });

  test("answers with the Worker's status, every Set-Cookie and the body", async () => {
    const target = await worker([]);
    const front = await metro(proxy.createDevProxy({ target, paths: ["/api/auth"] }));
    const response = await fetch(`${front}/api/auth/get-session`);
    expect(response.status).toBe(201);
    expect(response.headers.getSetCookie()).toEqual([
      "better-auth.session_token=abc; Path=/; HttpOnly",
      "pithy.acting=org_1; Path=/",
    ]);
    expect(await response.json()).toEqual({ ok: true });
  });

  test("hands every other path to Metro, and never calls the Worker for it", async () => {
    const seen: Seen[] = [];
    const target = await worker(seen);
    const front = await metro(proxy.createDevProxy({ target, paths: ["/api/auth"] }));
    const response = await fetch(`${front}/index.bundle?platform=web`);
    expect(response.status).toBe(404);
    expect(await response.text()).toBe("next");
    expect(seen).toEqual([]);
  });

  test("a Worker that drops the connection mid-answer ends that response, and Metro keeps serving", async () => {
    const target = await listen((_req, res) => {
      res.writeHead(200, { "content-type": "text/plain", "content-length": "100" });
      res.write("partial");
      setTimeout(() => res.socket?.destroy(), 20);
    });
    const front = await metro(proxy.createDevProxy({ target, paths: ["/api/auth"] }));
    const dropped = await fetch(`${front}/api/auth/get-session`, { signal: AbortSignal.timeout(2000) });
    const failure: unknown = await dropped.text().then(
      () => null,
      (error: unknown) => error,
    );
    // The browser sees the answer break off, not a request left open until it gives up.
    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).name).not.toBe("TimeoutError");
    expect(await (await fetch(`${front}/index.bundle`)).text()).toBe("next");
  });

  test("sends the Worker the path it matched, dot segments resolved", async () => {
    const seen: Seen[] = [];
    const target = await worker(seen);
    const front = new URL(await metro(proxy.createDevProxy({ target, paths: ["/api/auth"] })));
    // `fetch` resolves dot segments before it sends; a raw request keeps them, as any client on the network can.
    const status = await new Promise<number | undefined>((done, fail) => {
      const raw = request(
        { hostname: front.hostname, port: front.port, path: "/api/auth/./x/%2e%2e/get-session?a=1" },
        (answer) => {
          answer.resume();
          answer.on("end", () => done(answer.statusCode));
        },
      );
      raw.on("error", fail);
      raw.end();
    });
    expect(status).toBe(201);
    expect(seen.map((request) => request.url)).toEqual(["/api/auth/get-session?a=1"]);
  });

  test("a page that gives up on a call releases the Worker's end of it", async () => {
    let released: () => void = () => undefined;
    const workerSawClose = new Promise<void>((done) => {
      released = done;
    });
    const target = await listen((req) => {
      req.socket.on("close", () => released());
    });
    const front = await metro(proxy.createDevProxy({ target, paths: ["/api/auth"] }));
    const leaving = new AbortController();
    const call = fetch(`${front}/api/auth/get-session`, { signal: leaving.signal }).catch(() => undefined);
    await new Promise((done) => setTimeout(done, 50));
    leaving.abort();
    await call;
    const outcome = await Promise.race([
      workerSawClose.then(() => "released"),
      new Promise((done) => setTimeout(() => done("held"), 1000)),
    ]);
    expect(outcome).toBe("released");
  });

  test("a Worker that is not running is a 502 that names where it looked", async () => {
    const gone = await listen(() => undefined);
    await new Promise((done) => servers.pop()?.close(done));
    const front = await metro(proxy.createDevProxy({ target: gone, paths: ["/health"] }));
    const response = await fetch(`${front}/health`);
    expect(response.status).toBe(502);
    expect(await response.text()).toContain(gone);
  });
});

/** A project with the app at `apps/app` and, when `wrangler` is given, the Worker it calls at `apps/api`. */
async function project(files: { manifest?: string; wrangler?: string }): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "pithy-metro-project-"));
  dirs.push(root);
  const app = join(root, "apps", "app");
  await mkdir(join(app, "src"), { recursive: true });
  if (files.manifest !== undefined) await writeFile(join(app, "pithy.worker.jsonc"), files.manifest);
  if (files.wrangler !== undefined) {
    await mkdir(join(root, "apps", "api"), { recursive: true });
    await writeFile(join(root, "apps", "api", "wrangler.jsonc"), files.wrangler);
  }
  return app;
}

const callsApi = `{
  // Written by pithy ui add.
  "dev": { "command": ["bun", "x", "expo", "start"] },
  "ui": { "stub": "react-native", "build": ["expo", "export"], "worker": "api", },
}`;

describe("the Worker origin the dev proxy prefers", () => {
  test("the stem is the one pithy dev derives, for every shape of name", () => {
    for (const name of ["api", "demo-api", "media.cli", "-web--app.", "worker2", "My Worker", "a_b"]) {
      expect(proxy.envStem(name), name).toBe(envStem(name));
      expect(`${proxy.envStem(name)}_ORIGIN`, name).toBe(originVarName(name));
    }
  });

  test("names the Worker in ui.worker by its wrangler.jsonc name", async () => {
    const app = await project({
      manifest: callsApi,
      wrangler: '{\n  // The deployed name.\n  "name": "demo-api",\n  "main": "src/index.ts",\n}\n',
    });
    expect(proxy.workerOriginVar(app)).toBe("DEMO_API_ORIGIN");
  });

  test("a Worker whose wrangler.jsonc names none goes by its directory, as pithy dev names it", async () => {
    expect(proxy.workerOriginVar(await project({ manifest: callsApi, wrangler: "{}" }))).toBe("API_ORIGIN");
    expect(proxy.workerOriginVar(await project({ manifest: callsApi, wrangler: "not json" }))).toBe("API_ORIGIN");
    expect(proxy.workerOriginVar(await project({ manifest: callsApi }))).toBe("API_ORIGIN");
  });

  test("an app with no readable ui.worker names no variable", async () => {
    expect(proxy.workerOriginVar(await project({}))).toBeNull();
    expect(proxy.workerOriginVar(await project({ manifest: "{ ui: " }))).toBeNull();
    expect(proxy.workerOriginVar(await project({ manifest: '{ "dev": {} }' }))).toBeNull();
    expect(proxy.workerOriginVar(await project({ manifest: '{ "ui": { "stub": "react-native" } }' }))).toBeNull();
    expect(proxy.workerOriginVar(await project({ manifest: '{ "ui": { "worker": "" } }' }))).toBeNull();
    expect(proxy.workerOriginVar(await project({ manifest: '{ "ui": { "worker": 7 } }' }))).toBeNull();
  });

  test("the exported origin is the variable pithy dev sets for that Worker, and none when it is unset or empty", async () => {
    const app = await project({ manifest: callsApi, wrangler: '{ "name": "demo-api" }' });
    expect(proxy.exportedOrigin(app, { DEMO_API_ORIGIN: "http://localhost:9901" })).toBe("http://localhost:9901");
    expect(proxy.exportedOrigin(app, {})).toBeNull();
    expect(proxy.exportedOrigin(app, { DEMO_API_ORIGIN: "" })).toBeNull();
    expect(proxy.exportedOrigin(await project({}), { API_ORIGIN: "http://localhost:9901" })).toBeNull();
  });

  test("the origin pithy dev exports for that Worker wins over origins.dev", async () => {
    const app = await project({ manifest: callsApi, wrangler: '{ "name": "demo-api" }' });
    expect(proxy.devTarget(composed, app, { DEMO_API_ORIGIN: "http://localhost:9901" })).toBe("http://localhost:9901");
  });

  test("with that variable unset or empty, origins.dev", async () => {
    const app = await project({ manifest: callsApi, wrangler: '{ "name": "demo-api" }' });
    expect(proxy.devTarget(composed, app, {})).toBe("http://localhost:8787");
    expect(proxy.devTarget(composed, app, { DEMO_API_ORIGIN: "" })).toBe("http://localhost:8787");
    expect(proxy.devTarget(composed, app, { API_ORIGIN: "http://localhost:9901" })).toBe("http://localhost:8787");
  });

  test("an app with no readable ui.worker reads origins.dev, whatever the environment holds", async () => {
    const app = await project({});
    expect(proxy.devTarget(composed, app, { API_ORIGIN: "http://localhost:9901" })).toBe("http://localhost:8787");
  });
});

describe("the Metro config's middleware", () => {
  async function appDir(text: string): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), "pithy-metro-"));
    dirs.push(dir);
    await mkdir(join(dir, "src"), { recursive: true });
    await writeFile(join(dir, GENERATED_CONFIG_PATH), text);
    return dir;
  }

  test("forwards a capability mounted away from its default path, as the generated config lists it", async () => {
    const seen: Seen[] = [];
    const target = await worker(seen);
    const dir = await appDir(
      renderGeneratedConfig({ ...composed, origins: { dev: target }, workerPaths: ["/health", "/teams"] }, "api"),
    );
    const middleware = proxy.withDevProxy({}, dir).server.enhanceMiddleware?.(metroOwn, {});
    if (middleware === undefined) throw new Error("no middleware");
    const front = await metro(middleware);
    expect((await fetch(`${front}/teams/acme`)).status).toBe(201);
    expect(seen.map((request) => request.url)).toEqual(["/teams/acme"]);
  });

  test("in a feature worktree, sends the Worker's paths to the origin pithy dev exports for it", async () => {
    const seen: Seen[] = [];
    const target = await worker(seen);
    const main = await listen(() => undefined);
    await new Promise((done) => servers.pop()?.close(done));
    const app = await project({ manifest: callsApi, wrangler: '{ "name": "demo-api" }' });
    await writeFile(
      join(app, GENERATED_CONFIG_PATH),
      renderGeneratedConfig({ ...composed, origins: { dev: main } }, "api"),
    );
    const middleware = proxy
      .withDevProxy({}, app, undefined, { DEMO_API_ORIGIN: target })
      .server.enhanceMiddleware?.(metroOwn, {});
    if (middleware === undefined) throw new Error("no middleware");
    const front = await metro(middleware);
    expect((await fetch(`${front}/api/auth/get-session`)).status).toBe(201);
    expect(seen.map((request) => request.url)).toEqual(["/api/auth/get-session"]);
  });

  test("puts the proxy in front of Metro's middleware and any enhancer already there", async () => {
    const seen: Seen[] = [];
    const target = await worker(seen);
    const dir = await appDir(renderGeneratedConfig({ ...composed, origins: { dev: target } }, "api"));
    const order: string[] = [];
    const enhanced = proxy.withDevProxy(
      {
        resolver: { kept: true },
        server: {
          port: 8081,
          enhanceMiddleware: (inner: Middleware) => {
            order.push("earlier enhancer");
            return inner;
          },
        },
      },
      dir,
    );
    expect(enhanced.server.port).toBe(8081);
    expect((enhanced as unknown as { resolver: unknown }).resolver).toEqual({ kept: true });
    const middleware = enhanced.server.enhanceMiddleware?.(metroOwn, {});
    expect(order).toEqual(["earlier enhancer"]);
    if (middleware === undefined) throw new Error("no middleware");
    const front = await metro(middleware);
    expect((await fetch(`${front}/organizations`)).status).toBe(201);
    expect(await (await fetch(`${front}/index.bundle`)).text()).toBe("metro");
    expect(seen.map((request) => request.url)).toEqual(["/organizations"]);
  });

  test("a config it cannot read leaves Metro as it was, and says why", async () => {
    const dir = await appDir("export default {};\n");
    const warnings: string[] = [];
    const config = { server: { port: 8081 } };
    expect(proxy.withDevProxy(config, dir, (message) => warnings.push(message))).toBe(config);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain(GENERATED_CONFIG_PATH);
  });

  test("metro.config.js is Expo's default config with the proxy added", async () => {
    const text = await readFile(join(TEMPLATE_DIR, "metro.config.js"), "utf8");
    expect(text).toContain('require("expo/metro-config")');
    expect(text).toContain("getDefaultConfig(__dirname)");
    expect(text).toContain('require("./metro-proxy.cjs")');
    expect(text).toContain("withDevProxy(");
    expect(TEMPLATE_GROUPS.base).toEqual(expect.arrayContaining(["metro.config.js", "metro-proxy.cjs"]));
  });
});

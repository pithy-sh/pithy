// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { type ChildProcess, spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { createRequire } from "node:module";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { TEMPLATE_DIR } from "@pithy-sh/ui-react-native/src/templates";
import { parse } from "comment-json";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { resolveTemplateSource } from "../project/scaffold";

/**
 * The Expo web build's dev proxy (`templates/metro-proxy.cjs`), in front of a real `wrangler dev`.
 *
 * Under `pithy dev` the web build is served by Metro on its own port, and the proxy sends the Worker's paths on with
 * the page's `Host`. That is what lets the Worker answer as same-origin with the page: `wrangler dev` builds the
 * request's URL from `Host`, so a `dev` composition resolves its own origin as the page's, the browser's `Origin`
 * matches it, and the cookie it sets lands on the host the page reads it from. Every link of that is a fact about
 * `wrangler dev` a stand-in server would only assume, so this boots the real one.
 */

type Middleware = (req: IncomingMessage, res: ServerResponse, next: () => void) => void;
const proxy = createRequire(import.meta.url)(join(TEMPLATE_DIR, "metro-proxy.cjs")) as {
  createDevProxy(input: { target: string; paths: readonly string[] }): Middleware;
};

const MODULES = join(import.meta.dirname, "..", "..", "node_modules");
const WRANGLER = join(MODULES, ".bin", "wrangler");

/**
 * The Worker under test. It composes auth's own same-origin gate, the one every cookie-authenticated write passes,
 * and two routes under `/auth`: one that sets a cookie the way a sign-in does, and one write behind the gate that
 * answers with the cookie it was sent. Better Auth itself is not bundled: a Worker composing it pulls an optional
 * import no bundler in this repo resolves. The gate, and the origin it resolves in `dev`, are what the proxy can
 * break. Written beside this package's modules, so its imports resolve the way the CLI's do.
 */
const WORKER_SOURCE = `
import { publishSameOrigin } from "@pithy-sh/auth/src/http/csrf";
import { defineCapability } from "@pithy-sh/core/src/capability/capability";
import { createEntrypoint } from "@pithy-sh/core/src/createEntrypoint";
import { requireSameOrigin } from "@pithy-sh/core/src/http/sameOrigin";

const gate = defineCapability({
  name: "auth",
  requiredBindings: [],
  middleware: [publishSameOrigin({ config: { baseURL: "https://api.example.com", trustedOrigins: [] } })],
  routes: (app) => {
    app.get("/auth/start", (c) => {
      c.header("set-cookie", "pithy.session=signed-in; Path=/; HttpOnly; SameSite=Lax");
      return c.json({ url: c.req.url });
    });
    app.post("/auth/write", requireSameOrigin(), (c) => c.json({ url: c.req.url, cookie: c.req.header("cookie") ?? null }));
  },
});

export default createEntrypoint({ capabilities: [gate] });
`;

let state: string;
let wrangler: ChildProcess | undefined;
let metro: Server | undefined;
let page = "";

/** A port nothing is listening on right now. */
async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const { port } = server.address() as AddressInfo;
  await new Promise((done) => server.close(done));
  return port;
}

/** Wait for `wrangler dev` to answer on `origin`, or fail with what it printed. */
async function ready(origin: string, output: () => string): Promise<void> {
  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline) {
    try {
      if ((await fetch(`${origin}/health`)).ok) return;
    } catch {
      // Not listening yet.
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`wrangler dev never answered on ${origin}:\n${output()}`);
}

beforeAll(async () => {
  await mkdir(join(MODULES, ".cache"), { recursive: true });
  state = await mkdtemp(join(MODULES, ".cache", "pithy-dev-proxy-"));
  const worker = join(state, "worker.js");
  await writeFile(worker, WORKER_SOURCE);
  const port = await freePort();
  // The date and flags a scaffolded Worker runs on, read from the starter rather than written here.
  const starter = parse(
    await readFile(join(resolveTemplateSource(import.meta.dirname).dir, "apps", "api", "wrangler.jsonc"), "utf8"),
  ) as unknown as { compatibility_date: string; compatibility_flags: string[] };
  let output = "";
  wrangler = spawn(
    WRANGLER,
    [
      "dev",
      worker,
      "--name",
      "dev-proxy",
      "--ip",
      "127.0.0.1",
      "--port",
      String(port),
      "--compatibility-date",
      starter.compatibility_date,
      ...starter.compatibility_flags.flatMap((flag) => ["--compatibility-flags", flag]),
      "--var",
      "ENVIRONMENT:dev",
      "--persist-to",
      join(state, "state"),
      "--show-interactive-dev-session=false",
    ],
    { cwd: state, env: { ...process.env, WRANGLER_SEND_METRICS: "false", CI: "true" }, stdio: "pipe" },
  );
  wrangler.stdout?.on("data", (chunk: Buffer) => {
    output += chunk.toString();
  });
  wrangler.stderr?.on("data", (chunk: Buffer) => {
    output += chunk.toString();
  });
  const target = `http://127.0.0.1:${port}`;
  await ready(target, () => output);

  // Metro, as far as the proxy sees it: a server that hands the proxy every request and answers the rest itself.
  const middleware = proxy.createDevProxy({ target, paths: ["/auth", "/health"] });
  metro = createServer((req, res) => middleware(req, res, () => res.end("metro")));
  await new Promise<void>((done) => metro?.listen(0, "127.0.0.1", done));
  page = `http://localhost:${(metro.address() as AddressInfo).port}`;
}, 120_000);

afterAll(async () => {
  metro?.closeAllConnections();
  await new Promise((done) => (metro ? metro.close(done) : done(undefined)));
  if (wrangler && wrangler.exitCode === null) {
    const exited = new Promise((done) => wrangler?.once("exit", done));
    wrangler.kill("SIGTERM");
    await Promise.race([exited, new Promise((done) => setTimeout(done, 5_000))]);
    if (wrangler.exitCode === null) wrangler.kill("SIGKILL");
  }
  await rm(state, { recursive: true, force: true });
});

/** A browser on the page: a cookie jar for its host, and `Origin` on every write. */
function browser(origin: string): (path: string, method?: string) => Promise<Response> {
  const jar = new Map<string, string>();
  return async (path, method = "GET") => {
    const headers = new Headers();
    if (method !== "GET") headers.set("origin", origin);
    if (jar.size > 0) headers.set("cookie", [...jar].map(([name, value]) => `${name}=${value}`).join("; "));
    const response = await fetch(`${page}${path}`, { method, headers });
    for (const cookie of response.headers.getSetCookie()) {
      const pair = cookie.split(";")[0] ?? "";
      const split = pair.indexOf("=");
      if (split > 0) jar.set(pair.slice(0, split), pair.slice(split + 1));
    }
    return response;
  };
}

describe("the web build's dev proxy, in front of wrangler dev", () => {
  test("the Worker sees the request on the page's origin", async () => {
    const answer = await browser(page)("/auth/start");
    expect(answer.status).toBe(200);
    expect(((await answer.json()) as { url: string }).url).toBe(`${page}/auth/start`);
  });

  test("a cookie the Worker sets comes back on the next write, and the same-origin gate lets the page's write through", async () => {
    const send = browser(page);
    expect((await send("/auth/start")).headers.getSetCookie()).toEqual([
      "pithy.session=signed-in; Path=/; HttpOnly; SameSite=Lax",
    ]);
    const written = await send("/auth/write", "POST");
    expect(written.status).toBe(200);
    expect(await written.json()).toEqual({ url: `${page}/auth/write`, cookie: "pithy.session=signed-in" });
  });

  test("a write from any other origin is still refused", async () => {
    const send = browser("http://elsewhere.example");
    await send("/auth/start");
    expect((await send("/auth/write", "POST")).status).toBe(403);
  });

  test("everything else stays with Metro", async () => {
    expect(await (await fetch(`${page}/index.bundle`)).text()).toBe("metro");
  });
});

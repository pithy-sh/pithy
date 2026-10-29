// The web build's way to the Worker under `pithy dev`.
//
// The web build calls the Worker by relative path, and in production that is right: the build is served from the
// Worker's own origin. Under `pithy dev` it is served by Metro, on Metro's own port, so a relative call reaches
// Metro. This sends the requests under the Worker's paths on to `origins.dev` in `src/pithy-config.generated.ts`,
// and hands Metro everything else.
//
// A request goes on as it came: method, headers and body, with its path and query resolved the way the Worker
// resolves them, so a path is matched where it lands. Its `Host` stays the page's, so the Worker answers it as
// same-origin with the page that sent it and sets its cookies there. The answer comes back as the Worker gave it:
// status, every header and every `Set-Cookie`, and the body.
//
// Metro runs this middleware only while it serves. `expo export` builds without it. Metro reads the config when it
// starts, so restart it after `pithy ui sync --app` rewrites the file.
//
// Node's own modules only: Metro loads this file before anything is bundled.

const fs = require("node:fs");
const http = require("node:http");
const https = require("node:https");
const path = require("node:path");
const { pipeline } = require("node:stream");

/** Where the generated config sits, relative to the app. */
const GENERATED_CONFIG = "src/pithy-config.generated.ts";

/** Where the kit's clients call each capability by default, for a generated config that lists no paths. */
const KIT_PATHS = {
  organization: "/organizations",
  consent: "/consent",
  mcp: "/mcp",
  health: "/health",
  turnstile: "/turnstile",
};

/** Where an MCP client discovers the Worker's authorization server. Auth serves them. */
const OAUTH_DISCOVERY = ["/.well-known/oauth-authorization-server", "/.well-known/oauth-protected-resource"];

/**
 * The app's own screens whose path is also a capability's base path. Metro serves the screen; the routes under
 * it are the Worker's.
 */
const SCREEN_PATHS = ["/consent"];

/** The line the generated value starts on. The value runs from there to `export default config`. */
const OPEN = "const config: GeneratedPithyConfig = ";
const CLOSE = /;\s*export default config;\s*$/;

/** A literal this reader cannot read. */
class Unreadable extends Error {}

/**
 * The object literal in `text`: JSON, plus what a formatter or a hand edit leaves in a TypeScript literal, which is
 * a key without quotes, a single-quoted string, a trailing comma and a comment. Anything else, such as an
 * expression, throws: the file is read, never run.
 */
function parseLiteral(text) {
  let at = 0;
  const skip = () => {
    for (;;) {
      while (at < text.length && /\s/.test(text[at])) at += 1;
      if (text.startsWith("//", at)) {
        const end = text.indexOf("\n", at);
        at = end === -1 ? text.length : end + 1;
      } else if (text.startsWith("/*", at)) {
        const end = text.indexOf("*/", at + 2);
        if (end === -1) throw new Unreadable();
        at = end + 2;
      } else return;
    }
  };
  const consume = (char) => {
    skip();
    if (text[at] !== char) throw new Unreadable();
    at += 1;
  };
  const string = () => {
    const quote = text[at];
    let end = at + 1;
    let raw = "";
    while (end < text.length && text[end] !== quote) {
      const char = text[end];
      if (char === "\n") throw new Unreadable();
      if (char === "\\") {
        const next = text[end + 1] ?? "";
        raw += next === "'" ? "'" : char + next;
        end += 2;
        continue;
      }
      raw += char === '"' ? '\\"' : char;
      end += 1;
    }
    if (end >= text.length) throw new Unreadable();
    at = end + 1;
    try {
      return JSON.parse(`"${raw}"`);
    } catch {
      throw new Unreadable();
    }
  };
  const value = () => {
    skip();
    const char = text[at];
    if (char === "{") {
      at += 1;
      const object = {};
      for (;;) {
        skip();
        if (text[at] === "}") {
          at += 1;
          return object;
        }
        let key;
        if (text[at] === '"' || text[at] === "'") key = string();
        else {
          const name = /^[A-Za-z_$][A-Za-z0-9_$]*/.exec(text.slice(at))?.[0];
          if (name === undefined) throw new Unreadable();
          key = name;
          at += name.length;
        }
        consume(":");
        Object.defineProperty(object, key, { value: value(), enumerable: true, writable: true, configurable: true });
        skip();
        if (text[at] === ",") at += 1;
        else if (text[at] !== "}") throw new Unreadable();
      }
    }
    if (char === "[") {
      at += 1;
      const array = [];
      for (;;) {
        skip();
        if (text[at] === "]") {
          at += 1;
          return array;
        }
        array.push(value());
        skip();
        if (text[at] === ",") at += 1;
        else if (text[at] !== "]") throw new Unreadable();
      }
    }
    if (char === '"' || char === "'") return string();
    const word = /^(?:true|false|null|-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?)(?![A-Za-z0-9_$.])/.exec(
      text.slice(at),
    )?.[0];
    if (word === undefined) throw new Unreadable();
    at += word.length;
    return JSON.parse(word);
  };
  const parsed = value();
  skip();
  if (at !== text.length) throw new Unreadable();
  return parsed;
}

/**
 * The value in a generated config's text, or `null` when the text is not one Pithy wrote. A file the project's
 * formatter has reformatted, or an adopter has edited by hand, still reads.
 */
function readGeneratedConfig(text) {
  const start = text.indexOf(OPEN);
  const close = CLOSE.exec(text);
  if (start === -1 || close === null || close.index < start) return null;
  try {
    const value = parseLiteral(text.slice(start + OPEN.length, close.index));
    return value && typeof value === "object" && value.origins && typeof value.origins.dev === "string" ? value : null;
  } catch {
    return null;
  }
}

/**
 * The paths the Worker answers. The generated config lists every base path the Worker's route table serves, as the
 * CLI composed it; a config written before it carried the list falls back to what each capability's `dev`
 * projection composes, since `pithy dev` serves `dev`, and the kit's defaults for the rest.
 */
function proxiedPaths(config) {
  if (Array.isArray(config.workerPaths) && config.workerPaths.every((path) => typeof path === "string")) {
    return config.workerPaths;
  }
  const dev = (field) => config[field]?.dev;
  const consent = dev("consent")?.enabled ? dev("consent").basePath : KIT_PATHS.consent;
  const paths = [KIT_PATHS.organization, consent, KIT_PATHS.mcp, KIT_PATHS.health];
  if (dev("auth")?.enabled) paths.push(dev("auth").basePath, ...OAUTH_DISCOVERY);
  if (dev("payments")?.enabled) paths.push(dev("payments").basePath);
  if (dev("turnstile")?.enabled) paths.push(KIT_PATHS.turnstile);
  return paths;
}

/** The base a request target is resolved against. A target that names any other origin is not a path. */
const LOCAL = "http://metro.invalid";

/**
 * The path and query to send the Worker for `url`, a request's target, or `null` when it stays with Metro. The
 * target is resolved the way the Worker resolves it, dot segments and backslashes included, so a path that climbs
 * out of a base path is matched where it lands.
 */
function workerPath(url, paths) {
  let resolved;
  try {
    resolved = new URL(url, LOCAL);
  } catch {
    return null;
  }
  if (resolved.origin !== LOCAL) return null;
  const { pathname, search } = resolved;
  if (SCREEN_PATHS.includes(pathname)) return null;
  const under = paths.some((base) => pathname === base || pathname.startsWith(`${base}/`));
  return under ? `${pathname}${search}` : null;
}

/** Whether `url`, a request's target, goes to the Worker: under one of `paths`, and not one of the app's screens. */
function isProxied(url, paths) {
  return workerPath(url, paths) !== null;
}

/** A middleware that sends a request under `paths` to `target`, and any other to the next middleware. */
function createDevProxy({ target, paths }) {
  const upstream = new URL(target);
  const send = upstream.protocol === "https:" ? https.request : http.request;
  return (req, res, next) => {
    const forward = workerPath(req.url || "/", paths);
    if (forward === null) {
      next();
      return;
    }
    const outgoing = send(
      {
        protocol: upstream.protocol,
        hostname: upstream.hostname.replace(/^\[|\]$/g, ""),
        port: upstream.port,
        method: req.method,
        path: forward,
        headers: req.headers,
      },
      (answer) => {
        res.writeHead(answer.statusCode || 502, answer.statusMessage, answer.rawHeaders);
        pipeline(answer, res, () => undefined);
      },
    );
    res.on("close", () => {
      if (!res.writableFinished) outgoing.destroy();
    });
    outgoing.on("error", (error) => {
      if (res.headersSent) {
        res.destroy(error);
        return;
      }
      res.writeHead(502, { "content-type": "text/plain; charset=utf-8" });
      res.end(`The Worker did not answer at ${target}. Start it with pithy dev. ${error.message}\n`);
    });
    req.pipe(outgoing);
  };
}

/**
 * `config` with the dev proxy in front of Metro's middleware, and of any enhancer already there. A generated
 * config it cannot read leaves `config` as it was, and says why.
 */
function withDevProxy(config, appDir, warn = console.warn) {
  let generated = null;
  try {
    generated = readGeneratedConfig(fs.readFileSync(path.join(appDir, GENERATED_CONFIG), "utf8"));
  } catch {
    generated = null;
  }
  if (generated === null) {
    warn(
      `The web build cannot reach the Worker under Metro: ${GENERATED_CONFIG} is not a file Pithy wrote. Run pithy ui sync --app.`,
    );
    return config;
  }
  const proxy = createDevProxy({ target: generated.origins.dev, paths: proxiedPaths(generated) });
  const server = config.server || {};
  const earlier = server.enhanceMiddleware;
  return {
    ...config,
    server: {
      ...server,
      enhanceMiddleware: (middleware, metro) => {
        const inner = earlier ? earlier(middleware, metro) : middleware;
        return (req, res, next) => proxy(req, res, () => inner(req, res, next));
      },
    },
  };
}

module.exports = { KIT_PATHS, readGeneratedConfig, proxiedPaths, isProxied, createDevProxy, withDevProxy };

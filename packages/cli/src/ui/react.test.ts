import { beforeAll, describe, expect, test } from "vitest";
import { reactStub } from "./react";
import { loadStubFiles } from "./templates";

// The templates are real files in @pithy-sh/ui-react, so reading them is I/O. The manifest that
// says WHICH of them a given context writes stays pure, and is asserted as a value below.
let BARE: Record<string, string>;
let AUTH: Record<string, string>;

beforeAll(async () => {
  BARE = await loadStubFiles(reactStub, { worker: "api", auth: false, packageManager: "bun" });
  AUTH = await loadStubFiles(reactStub, { worker: "api", auth: true, packageManager: "bun" });
});

/** Every route module the stub writes, by path. */
function routeModules(files: Record<string, string>): [string, string][] {
  return Object.entries(files).filter(([path]) => path.startsWith("src/routes/"));
}

describe("the React 19 stub", () => {
  test("manifest() is pure — the same context yields the same declaration", () => {
    const context = { worker: "api", auth: false, packageManager: "bun" } as const;
    const once = reactStub.manifest(context);
    const again = reactStub.manifest(context);
    expect(again).toEqual(once);
    expect(again).not.toBe(once);
  });

  test("every declared template exists on disk — a packaging fault fails here, not in an adopter's repo", async () => {
    for (const auth of [false, true]) {
      const files = await loadStubFiles(reactStub, { worker: "api", auth, packageManager: "bun" });
      for (const file of reactStub.manifest({ worker: "api", auth, packageManager: "bun" })) {
        expect(files[file.target], file.source).toBeTypeOf("string");
      }
    }
  });

  test("the worker name is substituted, and no token survives into the output", async () => {
    const files = await loadStubFiles(reactStub, { worker: "acme-api", auth: true, packageManager: "bun" });
    expect(files["index.html"]).toContain("acme-api");
    for (const [path, contents] of Object.entries(files)) {
      expect(contents, path).not.toContain("__PITHY_WORKER__");
    }
  });

  test("every client file is .tsx, so the worker's own tsconfig ignores the whole client", () => {
    // The worker's tsconfig includes `src/**/*.ts`, which does not match `.tsx`. The ambient
    // declarations sit at the worker root for the same reason — `.d.ts` WOULD match that glob.
    const sources = Object.keys(AUTH).filter((path) => path.startsWith("src/") && !path.endsWith(".css"));
    expect(sources.every((path) => path.endsWith(".tsx"))).toBe(true);
    expect(AUTH["client-env.d.ts"]).toBeDefined();
    expect(Object.keys(AUTH).some((path) => path.startsWith("src/") && path.endsWith(".d.ts"))).toBe(false);
  });

  test("the bare template has no auth imports and no dead files", () => {
    expect(Object.keys(BARE).sort()).toEqual([
      "client-env.d.ts",
      "index.html",
      "src/client.tsx",
      "src/router.tsx",
      "src/routes/app/home.tsx",
      "src/styles.css",
      "tsconfig.client.json",
      "tsconfig.node.json",
      "vite.config.ts",
    ]);
    for (const [path, contents] of Object.entries(BARE)) {
      if (path === "client-env.d.ts") continue;
      expect(contents, path).not.toMatch(/from ["']virtual:pithy\/auth["']/);
      expect(contents, path).not.toMatch(/from ["']virtual:pithy\/turnstile["']/);
    }
    // Home does one typed fetch and nothing else.
    expect(BARE["src/routes/app/home.tsx"]).toContain('fetch("/health"');
  });

  test("the auth template adds exactly the screens, the session hook, and the widget", () => {
    const added = Object.keys(AUTH).filter((path) => !(path in BARE));
    expect(added.sort()).toEqual([
      "src/pithy-config.tsx",
      "src/routes/pithy/callback.tsx",
      "src/routes/pithy/otp.tsx",
      "src/routes/pithy/sign-in.tsx",
      "src/session.tsx",
      "src/turnstile.tsx",
    ]);
    // Only home differs between the two templates; it gains the guard.
    const shared = Object.keys(BARE).filter((path) => path !== "src/routes/app/home.tsx");
    for (const path of shared) expect(AUTH[path], path).toBe(BARE[path]);
    expect(AUTH["src/routes/app/home.tsx"]).toContain('export const session = "required"');
  });

  test("every route module declares its own path — dropping a file in is the registration", () => {
    const modules = routeModules(AUTH);
    expect(modules.length).toBe(4);
    for (const [path, contents] of modules) {
      expect(contents, path).toMatch(/^export const path = "\/[^"]*";$/m);
    }
  });

  test("the router globs both route directories, lazily, with app winning on a conflict", () => {
    const router = AUTH["src/router.tsx"] ?? "";
    expect(router).toContain('import.meta.glob<RouteModule>("./routes/pithy/**/*.tsx")');
    expect(router).toContain('import.meta.glob<RouteModule>("./routes/app/**/*.tsx")');
    // Pithy first, app second, into a Map — the later set() wins.
    expect(router.indexOf("pithyRoutes, appRoutes")).toBeGreaterThan(-1);
    expect(router).toContain("Do not edit them.");
    expect(router).toContain("lazy(load)");
  });

  test("vite.config.ts carries the three plugins and the two facts that are easy to get wrong", () => {
    const config = AUTH["vite.config.ts"] ?? "";
    expect(config).toContain('import { cloudflare } from "@cloudflare/vite-plugin"');
    expect(config).toContain('import react from "@vitejs/plugin-react"');
    expect(config).toContain('import { pithy } from "@pithy-sh/vite/src/plugin"');
    // Project-root state, so a database shared with a sibling worker stays shared locally.
    expect(config).toContain('persistState: { path: "../../.wrangler/state" }');
    // Pinned off: the inspector silently advances off 9229 on a collision.
    expect(config).toContain("inspectorPort: false");
  });

  test("the client is cookie/session — no token store, no bearer header, no rotation", () => {
    for (const [path, contents] of Object.entries(AUTH)) {
      // Any *use* of web storage — a bare mention in a comment explaining why there is none is fine.
      expect(contents, path).not.toMatch(/\b(local|session)Storage\s*[.[]/);
      // The HEADER, not the word: prose about OAuth authorization endpoints is not a bearer token.
      expect(contents, path).not.toMatch(/["']?authorization["']?\s*:/i);
      expect(contents, path).not.toMatch(/\bBearer\b/);
      expect(contents, path).not.toContain("refreshToken");
    }
    expect(AUTH["src/session.tsx"]).toContain('credentials: "include"');
    expect(AUTH["src/session.tsx"]).toContain("/get-session");
  });

  test("the client calls its API same-origin — no CORS config and no origin variable", () => {
    for (const [path, contents] of Object.entries(AUTH)) {
      // The only absolute URL in the scaffold is Cloudflare's Turnstile script.
      const absolute = contents.match(/https?:\/\/[^"'\s`]+/g) ?? [];
      for (const url of absolute) {
        expect(url, `${path}: ${url}`).toContain("challenges.cloudflare.com");
      }
    }
  });

  test("only pithy-config.tsx imports a virtual module — every screen reads it narrowed", () => {
    // A NAMED import of a projection key breaks the build whenever that capability is not composed:
    // the module then exports `enabled` and nothing else. One narrowing module makes that impossible.
    const virtualImporters = Object.entries(AUTH)
      .filter(([path]) => path.endsWith(".tsx"))
      .filter(([, contents]) => /from "virtual:pithy\//.test(contents))
      .map(([path]) => path);
    expect(virtualImporters).toEqual(["src/pithy-config.tsx"]);
    const config = AUTH["src/pithy-config.tsx"] ?? "";
    expect(config).toContain('import authModule from "virtual:pithy/auth"');
    expect(config).toContain('import turnstileModule from "virtual:pithy/turnstile"');
    // Narrowed on the discriminant, not asserted past it.
    expect(config).toContain("authModule.enabled");
    expect(config).toContain("turnstileModule.enabled");
  });

  test("the sign-in screen renders from config, never from a flag", () => {
    const signIn = AUTH["src/routes/pithy/sign-in.tsx"] ?? "";
    expect(signIn).toContain('from "../../pithy-config"');
    for (const provider of ["google", "apple", "facebook", "github"]) {
      expect(signIn).toContain(`id: "${provider}"`);
    }
    // Only enabled providers render at all.
    expect(signIn).toContain("SOCIAL.filter((provider) => authConfig.providers[provider.id])");
    // Anti-enumeration: the answer never distinguishes a known address from an unknown one.
    expect(signIn).toContain("Check your inbox.");
    expect(signIn).not.toMatch(/no account/i);
  });

  test("the social redirect refuses a non-http(s) scheme before navigating to it", () => {
    const signIn = AUTH["src/routes/pithy/sign-in.tsx"] ?? "";
    // `window.location.href = url` with a javascript: URL executes in this page, so the response
    // body is scheme-checked first — the same guard @pithy-sh/email makes on a tracked link.
    expect(signIn).toContain('protocol === "https:" || protocol === "http:"');
    expect(signIn).toContain("window.location.href = body.url");
    // The check has to sit in the type guard the assignment is gated on, not merely somewhere nearby.
    const guard = signIn.slice(signIn.indexOf("function isRedirect"), signIn.indexOf("export default"));
    expect(guard).toContain("protocol");
  });

  test("the callback URL a provider is handed is always this app's own origin", () => {
    const signIn = AUTH["src/routes/pithy/sign-in.tsx"] ?? "";
    const callbacks = signIn.match(/callbackURL: `[^`]*`/g) ?? [];
    expect(callbacks.length).toBeGreaterThan(0);
    // Interpolated from the page's own origin, never a value from config or a response.
    for (const callback of callbacks) expect(callback).toContain("window.location.origin");
  });

  test("turnstile gates the magic-link and OTP forms only, at action login", () => {
    const widget = AUTH["src/turnstile.tsx"] ?? "";
    expect(widget).toContain('const ACTION = "login"');
    expect(widget).toContain("turnstileConfig.token.header");
    expect(widget).toContain("turnstileConfig.token.field");
    // The widget renders inside the email form on both screens, and nowhere near a social button.
    const signIn = AUTH["src/routes/pithy/sign-in.tsx"] ?? "";
    expect(signIn.indexOf("<Turnstile")).toBeLessThan(signIn.indexOf("enabledSocial.length > 0"));
    expect(AUTH["src/routes/pithy/otp.tsx"]).toContain("<Turnstile");
  });

  test("the OTP screen renders otpLength inputs, read from the same config the server validates against", () => {
    const otp = AUTH["src/routes/pithy/otp.tsx"] ?? "";
    expect(otp).toContain('from "../../pithy-config"');
    expect(otp).toContain("Array.from({ length: authConfig.otpLength }");
  });

  test("client-env.d.ts declares both virtual modules in BOTH templates", () => {
    // Create-never-overwrite means a later `pithy ui add --auth` cannot come back and add them,
    // so the bare scaffold has to carry them or the backfilled screens would not typecheck.
    for (const files of [BARE, AUTH]) {
      const ambient = files["client-env.d.ts"] ?? "";
      expect(ambient).toContain('declare module "virtual:pithy/auth"');
      expect(ambient).toContain('declare module "virtual:pithy/turnstile"');
      // Each module is a union discriminated on `enabled`, exported as the default — the shape that
      // makes an uncomposed capability narrow instead of breaking the build.
      expect(ambient).toContain("export default config;");
      expect(ambient).toContain("{ enabled: false }");
      expect(ambient).toContain("otpLength: number;");
      expect(ambient).toContain("signUpEnabled: boolean;");
    }
  });

  test("the declared packages are the verified Vite 8 / React 19 set", () => {
    expect(reactStub.dependencies).toMatchObject({ react: "^19.2.8", "react-dom": "^19.2.8" });
    // @vitejs/plugin-react 6.x is the Vite 8 line; 5.1.x does not support Vite 8.
    expect(reactStub.devDependencies["@vitejs/plugin-react"]).toBe("^6.0.4");
    expect(reactStub.devDependencies.vite).toBe("^8.0.16");
    expect(reactStub.devDependencies["@cloudflare/vite-plugin"]).toBe("^1.48.0");
  });
});

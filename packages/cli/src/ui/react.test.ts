// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { blankComments } from "@pithy-sh/core/src/text/comments";
import { PACKAGE_VERSION } from "@pithy-sh/core/src/version.generated";
import { TEMPLATE_DIR } from "@pithy-sh/ui-react/src/templates";
import { beforeAll, describe, expect, test } from "vitest";
import { kitRange } from "../project/scaffold";
import { reactStub } from "./react";
import { loadStubFiles } from "./templates";

/** The repo root, four levels up from `packages/cli/src/ui`. */
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../../..");

/**
 * A workspace package's own declared version — read from its own `package.json`, never inherited from a
 * sibling's. That inheritance is the defect these tests pin down.
 */
async function declaredVersion(name: string): Promise<string> {
  const path = join(REPO_ROOT, "packages", name.slice("@pithy-sh/".length), "package.json");
  return (JSON.parse(await readFile(path, "utf8")) as { version: string }).version;
}

// The templates are real files in @pithy-sh/ui-react, so reading them is I/O. The manifest that
// says WHICH of them a given context writes stays pure, and is asserted as a value below.
let BARE: Record<string, string>;
let AUTH: Record<string, string>;
let PAY: Record<string, string>;
let BOTH: Record<string, string>;

beforeAll(async () => {
  BARE = await loadStubFiles(reactStub, { worker: "api", auth: false, payments: false, packageManager: "bun" });
  AUTH = await loadStubFiles(reactStub, { worker: "api", auth: true, payments: false, packageManager: "bun" });
  PAY = await loadStubFiles(reactStub, { worker: "api", auth: false, payments: true, packageManager: "bun" });
  BOTH = await loadStubFiles(reactStub, { worker: "api", auth: true, payments: true, packageManager: "bun" });
});

/** Every route module the stub writes, by path. */
function routeModules(files: Record<string, string>): [string, string][] {
  // A co-located test is not a route module. `router.tsx`'s globs negate `*.test.tsx` and `*.spec.tsx`
  // for exactly that reason (#245), so this reads the same line the router does.
  return Object.entries(files).filter(([path]) => path.startsWith("src/routes/") && !path.includes(".test."));
}

describe("the React 19 stub", () => {
  test("manifest() is pure — the same context yields the same declaration", () => {
    const context = { worker: "api", auth: false, payments: false, packageManager: "bun" } as const;
    const once = reactStub.manifest(context);
    const again = reactStub.manifest(context);
    expect(again).toEqual(once);
    expect(again).not.toBe(once);
  });

  test("every declared template exists on disk — a packaging fault fails here, not in an adopter's repo", async () => {
    for (const auth of [false, true]) {
      const files = await loadStubFiles(reactStub, { worker: "api", auth, payments: false, packageManager: "bun" });
      for (const file of reactStub.manifest({ worker: "api", auth, payments: false, packageManager: "bun" })) {
        expect(files[file.target], file.source).toBeTypeOf("string");
      }
    }
  });

  test("the worker name is substituted, and no token survives into the output", async () => {
    const files = await loadStubFiles(reactStub, {
      worker: "acme-api",
      auth: true,
      payments: false,
      packageManager: "bun",
    });
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

  test("the bare template has no capability screens and no dead files", () => {
    // `src/pithy-config.tsx` is base rather than auth: it is the one module that narrows EVERY
    // capability's projection, and a payments-only scaffold needs it as much as an auth one does. It
    // compiles with nothing composed — each projection is `{ enabled: false }` and its defaults apply.
    expect(Object.keys(BARE).sort()).toEqual([
      "client-env.d.ts",
      "index.html",
      // The three gates base seeds. `client.tsx` mounts into a node it creates rather than one an id in
      // `index.html` names (#394), `router.tsx` sends a guard to the path the screen declares rather
      // than to a copy of it (#393), and `pithy-locale.tsx` makes the language the document declares and
      // the language it renders one value (#441). All three breaks were silent, so all three gates
      // travel (#391).
      "src/client.test.tsx",
      "src/client.tsx",
      // Base for the same reason `pithy-config.tsx` is: it is written whenever it is absent, which is
      // what makes a later `--auth` backfill produce screens whose classes something defines.
      "src/pithy-config.tsx",
      "src/pithy-locale.test.tsx",
      "src/pithy-locale.tsx",
      "src/pithy-screens.css",
      "src/router.test.tsx",
      "src/router.tsx",
      "src/routes/app/home.tsx",
      "src/styles.css",
      "tsconfig.client.json",
      "tsconfig.node.json",
      "vite.config.ts",
    ]);
    for (const [path, contents] of Object.entries(BARE)) {
      // The two files whose job is to name the virtual modules: the ambient declarations, and the one
      // module that narrows them.
      if (path === "client-env.d.ts" || path === "src/pithy-config.tsx") continue;
      expect(contents, path).not.toMatch(/from ["']virtual:pithy\//);
    }
    // Home does one typed fetch and nothing else — and it does not write down where.
    //
    // **This used to be `toContain('fetch("/health"')`, a literal compared to a literal inside the CLI
    // (#400).** It proved the two strings, not the contract: `createBackend` mounts the route, and a
    // rename there left this assertion green while the only screen a no-auth scaffold ships rendered
    // "The worker says: unknown." — a 200, no error, nothing in a log. So the path became one statement
    // in `@pithy-sh/core`, and what is held here is that the screen reads it rather than restating it.
    const home = BARE["src/routes/app/home.tsx"] ?? "";
    expect(home).toContain('import { HEALTH_PATH } from "@pithy-sh/core/src/worker/health"');
    expect(home).toContain("fetch(HEALTH_PATH)");
    // The reversal, refused in the only direction that stays honest: no `fetch` in this screen takes a
    // string at all. Asserting the *absence* of core's value cannot pass by having drifted onto it.
    expect(home, "the bare home screen fetches a literal path again").not.toMatch(/fetch\(\s*["'`]/);
  });

  test("the auth template adds exactly the screens, the session hook, the widget, and the widget's gate", () => {
    const added = Object.keys(AUTH).filter((path) => !(path in BARE));
    expect(added.sort()).toEqual([
      "src/routes/pithy/callback.tsx",
      "src/routes/pithy/otp.tsx",
      // The magic link's `callbackURL` is built from `callback.tsx`'s `path`, and this is what keeps
      // them one statement once both files are the adopter's (#393).
      "src/routes/pithy/sign-in.test.tsx",
      "src/routes/pithy/sign-in.tsx",
      "src/session.tsx",
      // The one test the kit seeds. `turnstile.tsx` becomes the adopter's the moment it lands and its
      // whole risk is that the action can be retyped into it — a drift no environment before production
      // can see (#374), so the gate travels with the file rather than staying here (#383).
      "src/turnstile.test.tsx",
      "src/turnstile.tsx",
    ]);
    // Only home differs between the two templates; it gains the guard.
    const shared = Object.keys(BARE).filter((path) => path !== "src/routes/app/home.tsx");
    for (const path of shared) expect(AUTH[path], path).toBe(BARE[path]);
    expect(AUTH["src/routes/app/home.tsx"]).toContain('export const session = "required"');
  });

  test("every route module declares its own path — dropping a file in is the registration", () => {
    // Four with auth, seven with payments as well. Every one of them, in every combination.
    expect(routeModules(AUTH).length).toBe(4);
    expect(routeModules(BOTH).length).toBe(7);
    for (const [path, contents] of routeModules(BOTH)) {
      expect(contents, path).toMatch(/^export const path = "\/[^"]*";$/m);
    }
  });

  test("the payments template adds exactly the three screens and the bridge", () => {
    const added = Object.keys(PAY).filter((path) => !(path in BARE));
    expect(added.sort()).toEqual([
      "src/payments.tsx",
      "src/routes/pithy/paywall.tsx",
      "src/routes/pithy/pricing.tsx",
      "src/routes/pithy/subscription.tsx",
    ]);
    // Nothing from the auth set rides along: a payments-only scaffold has no session hook and no widget.
    expect(PAY["src/session.tsx"]).toBeUndefined();
    expect(PAY["src/turnstile.tsx"]).toBeUndefined();
  });

  test("the two screen sets stack — one worker can compose both, and neither claims the other's files", () => {
    const authOnly = Object.keys(AUTH).filter((path) => !(path in BARE));
    const payOnly = Object.keys(PAY).filter((path) => !(path in BARE));
    expect(Object.keys(BOTH).sort()).toEqual([...Object.keys(BARE), ...authOnly, ...payOnly].sort());
    for (const path of payOnly) expect(BOTH[path], path).toBe(PAY[path]);
  });

  test("the screens call the package's hooks rather than reimplementing the purchase flow", () => {
    // The whole point of headless-in-the-package: a frozen paywall ages badly because store rules move,
    // so the flow upgrades with a minor release and only the rendering is written once.
    const screens = [
      "src/routes/pithy/paywall.tsx",
      "src/routes/pithy/pricing.tsx",
      "src/routes/pithy/subscription.tsx",
    ];
    for (const path of screens) {
      expect(PAY[path], path).toContain('from "@pithy-sh/payments/src/client/');
      // And no screen re-derives a request: every fetch of a payments route belongs to the package.
      expect(PAY[path], path).not.toMatch(/fetch\(/);
    }
    // The pricing screen quotes nothing of its own. Paddle names the figure, for this visitor, and a
    // number written into a file the adopter owns is one Pithy could never correct.
    expect(PAY["src/routes/pithy/pricing.tsx"]).toContain("usePricePreview");
    expect(PAY["src/routes/pithy/pricing.tsx"]).not.toMatch(/[$£€¥]\s?\d/);
  });

  test("the entitlement route guard is a redirect, and says it is not a security boundary", () => {
    const router = PAY["src/router.tsx"] ?? "";
    expect(router).toContain("import.meta.glob<{ holdsEntitlement:");
    // Where it sends them is the paywall screen's own `path`, read through the role it claims — never
    // a literal here, which is what made a rename redirect to the not-found screen (#393).
    expect(router).toContain('screenPath(table, "paywall")');
    expect(router).not.toMatch(/PAYWALL_PATH/);
    expect(PAY["src/routes/pithy/paywall.tsx"]).toContain('export const role = "paywall"');
    expect(router).toContain("never a security boundary");
    // The bridge answers it, and refuses to lock a screen when payments is not composed at all.
    expect(PAY["src/payments.tsx"]).toContain("export async function holdsEntitlement");
    expect(PAY["src/payments.tsx"]).toContain("if (!paymentsConfig.enabled) return true;");
  });

  test("no template writes another screen's path — a declared path is read, never restated", () => {
    // #393. Every one of these was two literals nothing compared: the router's `SIGN_IN_PATH`, the
    // magic link's `${origin}/callback`, `signOut`'s redirect, and two `<Link to="…">`. A rename
    // typechecked, built, and left the other end pointing at the not-found screen.
    //
    // The declaration itself is the one permitted mention, so the check is stated against it: a path
    // string may appear on the line that exports it and nowhere else in the scaffolded front end.
    for (const [path, contents] of Object.entries(BOTH)) {
      if (!path.endsWith(".tsx") || path.includes(".test.")) continue;
      const code = blankComments(contents);
      const declared = code.match(/^export const path = "(\/[^"]+)";$/m)?.[1];
      for (const screenPath of ["/sign-in", "/paywall", "/callback", "/otp", "/pricing", "/subscription"]) {
        if (screenPath === declared) continue;
        expect(code, `${path} writes ${screenPath} as a literal`).not.toContain(`"${screenPath}"`);
        expect(code, `${path} interpolates ${screenPath} as a literal`).not.toContain(`${screenPath}\``);
      }
    }
  });

  test("the guard machinery is in base, so the router is byte-identical in every template", () => {
    // It is globbed rather than imported for exactly this reason — the alternative is two routers.
    expect(BARE["src/router.tsx"]).toBe(PAY["src/router.tsx"]);
    expect(BARE["src/router.tsx"]).toBe(AUTH["src/router.tsx"]);
  });

  test("the router globs both route directories, lazily, with app winning on a conflict", () => {
    const router = AUTH["src/router.tsx"] ?? "";
    expect(router).toContain('"./routes/pithy/**/*.tsx"');
    expect(router).toContain('"./routes/app/**/*.tsx"');
    // #245: a co-located `home.test.tsx` was a route, and shipped the test runner to the browser. The
    // build gate is `@pithy-sh/ui-react`'s `routeGlob.test.ts`; this holds the negation in the file the
    // CLI copies, because the CLI is what puts it in front of an adopter.
    for (const directory of ["pithy", "app"]) {
      expect(router).toContain(`"!./routes/${directory}/**/*.test.tsx"`);
      expect(router).toContain(`"!./routes/${directory}/**/*.spec.tsx"`);
    }
    // Pithy first, app second, into a Map — the later set() wins.
    expect(router.indexOf("...Object.values(pithyRoutes)")).toBeGreaterThan(-1);
    expect(router.indexOf("...Object.values(appRoutes)")).toBeGreaterThan(
      router.indexOf("...Object.values(pithyRoutes)"),
    );
    expect(router).toContain("Do not edit them.");
    expect(router).toContain("lazy(load)");
  });

  test("the router the CLI copies matches path parameters", () => {
    // #291: without these a link-addressed screen — an invitation, a reset, an unsubscribe — cannot be
    // written without forking this file. The matching rules are tested in `@pithy-sh/ui-react`; what is
    // held here is that the file an adopter actually receives is the one that has them.
    const router = BARE["src/router.tsx"] ?? "";
    expect(router).toContain("export function matchPath");
    expect(router).toContain("export interface ScreenProps");
    expect(router).toContain("decodeURIComponent");
  });

  test("vite.config.ts carries the three plugins and the two facts that are easy to get wrong", () => {
    const config = AUTH["vite.config.ts"] ?? "";
    expect(config).toContain('import { cloudflare } from "@cloudflare/vite-plugin"');
    expect(config).toContain('import react from "@vitejs/plugin-react"');
    expect(config).toContain('import { pithy } from "@pithy-sh/vite/src/plugin"');
    // Project-root state, so a database shared with a sibling worker stays shared locally.
    //
    // **This asserts the string is there, and that is all it can assert.** The contract is a depth —
    // right relative to `apps/<worker>/`, wrong anywhere else — and a rename of the scaffolded layout
    // reads identically here. `scaffoldGates.test.ts` resolves it against a real project instead
    // (#399); keep this line as the cheap read, not as the gate.
    expect(config).toContain('persistState: { path: "../../.wrangler/state" }');
    // Pinned off: the inspector silently advances off 9229 on a collision.
    expect(config).toContain("inspectorPort: false");
  });

  test("the client is cookie/session — no token store, no bearer header, no rotation", () => {
    // Every template, not only the auth one: a scaffold that only leaked a token when payments was
    // requested would be a scaffold nobody checked.
    for (const [path, contents] of Object.entries(BOTH)) {
      // Any *use* of web storage — a bare mention in a comment explaining why there is none is fine.
      expect(contents, path).not.toMatch(/\b(local|session)Storage\s*[.[]/);
      // The HEADER, not the word: prose about OAuth authorization endpoints is not a bearer token.
      expect(contents, path).not.toMatch(/["']?authorization["']?\s*:/i);
      expect(contents, path).not.toMatch(/\bBearer\b/);
      expect(contents, path).not.toContain("refreshToken");
    }
    // **The cookie mode is no longer written here, and that is the fix rather than a regression
    // (#370).** A scaffolded file is copied into the adopter's repository and Pithy may never rewrite
    // it, so a transport spelled out in one is frozen at the moment they scaffolded. It lives in
    // `@pithy-sh/auth/src/client/api` now, whose `sameOrigin.test.ts` holds it to one producer; what
    // this scaffold has to get right is that the session module reaches the route through it.
    expect(BOTH["src/session.tsx"]).toContain('from "@pithy-sh/auth/src/client/api"');
    expect(BOTH["src/session.tsx"]).toContain("getSession as readSession");
    expect(BOTH["src/session.tsx"]).not.toContain('credentials: "include"');
  });

  test("the client calls its API same-origin — no CORS config and no origin variable", () => {
    for (const [path, contents] of Object.entries(BOTH)) {
      // A co-located test is not part of the client: nothing imports it, the route globs negate it,
      // and `routeGlob.test.ts` builds to prove it ships in no asset. An origin a gate renders a
      // screen against is a fixture, not a host anything reaches.
      if (path.includes(".test.")) continue;
      // **Comments are blanked first, and that is the invariant rather than a loophole.** What must
      // not appear is a host the running client *reaches*; a comment citing GitHub's or Google's brand
      // terms beside the mark they govern is documentation, and the rule beside the asset is exactly
      // where #257 decided those terms belong. So this reads the code.
      // The shared walk, so a `//` in a URL opens no comment: it is the one shape that could have
      // blanked a real host off the end of a line here (#439).
      const code = blankComments(contents);
      // The only absolute URL the client reaches is Cloudflare's Turnstile script. Not Stripe's:
      // hosted Checkout needs no SDK. Not the app stores': those URLs live in @pithy-sh/payments, so a
      // store moving one is a minor release rather than an edit to a file Pithy may never rewrite.
      const absolute = code.match(/https?:\/\/[^"'\s`]+/g) ?? [];
      for (const url of absolute) {
        expect(url, `${path}: ${url}`).toContain("challenges.cloudflare.com");
      }
    }
  });

  test("only pithy-config.tsx imports a virtual module — every screen reads it narrowed", () => {
    // A NAMED import of a projection key breaks the build whenever that capability is not composed:
    // the module then exports `enabled` and nothing else. One narrowing module makes that impossible.
    const virtualImporters = Object.entries(BOTH)
      .filter(([path]) => path.endsWith(".tsx"))
      .filter(([, contents]) => /from "virtual:pithy\//.test(contents))
      .map(([path]) => path);
    expect(virtualImporters).toEqual(["src/pithy-config.tsx"]);
    const config = BOTH["src/pithy-config.tsx"] ?? "";
    expect(config).toContain('import authModule from "virtual:pithy/auth"');
    expect(config).toContain('import turnstileModule from "virtual:pithy/turnstile"');
    expect(config).toContain('import paymentsModule from "virtual:pithy/payments"');
    expect(config).toContain('import i18nModule from "virtual:pithy/i18n"');
    // Narrowed on the discriminant, not asserted past it.
    expect(config).toContain("authModule.enabled");
    expect(config).toContain("turnstileModule.enabled");
    expect(config).toContain("paymentsModule.enabled");
  });

  test("the sign-in screen renders from config, never from a flag", () => {
    const signIn = AUTH["src/routes/pithy/sign-in.tsx"] ?? "";
    expect(signIn).toContain('from "../../pithy-config"');
    for (const provider of ["google", "apple", "facebook", "github"]) {
      expect(signIn).toContain(`id: "${provider}"`);
    }
    // Only enabled providers render at all.
    expect(signIn).toContain("SOCIAL.filter((provider) => auth.providers[provider.id])");
    // Anti-enumeration: the answer never distinguishes a known address from an unknown one. `setSent`
    // is unconditional and the response is discarded, so there is nothing for the copy to branch on —
    // stated about the code rather than as a banned phrase, because #257's account line is the words
    // "No account yet?" and it is about this visitor, not about an address that was submitted.
    expect(signIn).toContain("Check your inbox.");
    expect(signIn).toContain("If that address can sign in");
    const sendLink = signIn.slice(signIn.indexOf("async function sendLink"), signIn.indexOf("async function social"));
    expect(sendLink).toContain("setSent(true);");
    expect(sendLink).not.toMatch(/response|\.ok\b/);
  });

  test("one way in — the magic link, and nothing beside it", () => {
    // #257. Two passwordless paths on one screen is two things to explain, two surfaces to rate-limit,
    // and two inboxes' worth of mail for one intent. The OTP screen stays in the tree; nothing on the
    // sign-in screen sends anybody to it.
    const signIn = AUTH["src/routes/pithy/sign-in.tsx"] ?? "";
    // The route path moved into `@pithy-sh/auth` with the request (#370), so the screen names the
    // intent. One intent is still the assertion, and it is the same one.
    expect(signIn).toContain("sendMagicLink(");
    expect(signIn).not.toContain("email-otp");
    expect(signIn).not.toContain("sendOtp");
    expect(signIn).not.toContain("/otp?");
    // The one submit is the form's. A second `type="submit"` is a second intent on one screen.
    expect(signIn.match(/type="submit"/g) ?? []).toHaveLength(1);
  });

  test("the brand panel is a slot, and it ships empty", () => {
    // #257. The panel carries product claims — what a company does and does not keep — and a template
    // shipping someone else's claims is a template deployed with them still in it.
    const signIn = AUTH["src/routes/pithy/sign-in.tsx"] ?? "";
    expect(signIn).toContain("const BRAND: ReactNode = null;");
    expect(signIn).toContain("const MARK: ReactNode = null;");
    // And the layout is told, so an empty slot is one column rather than a blank one.
    expect(signIn).toContain('data-brand={props.brand ? "set" : "none"}');
  });

  test("the social redirect is followed only from the branch the package vetted", () => {
    const signIn = AUTH["src/routes/pithy/sign-in.tsx"] ?? "";
    // **Both checks moved into `@pithy-sh/auth` with the request itself (#370)**, where they upgrade
    // with a minor release rather than being frozen into an adopter's copy of this file: the scheme
    // check, because `window.location.href = url` with a `javascript:` URL executes in this page, and
    // #257's `client_id` check, because an authorization URL naming no client is a provider switched
    // on with a blank credential behind it. `startSocialSignIn` answers with a discriminated outcome
    // and `packages/auth/src/client/api.test.ts` holds both halves.
    //
    // What has to be true in the scaffolded file is the other half: the navigator is reached from the
    // vetted branch and from nowhere else. An unvetted URL reaching `redirect` is the whole defect.
    expect(signIn).toContain("startSocialSignIn(");
    expect(signIn).toContain('if (started.kind === "authorize") {');
    expect(signIn).toContain("redirect(started.url);");
    expect(signIn).toContain("window.location.href = url;");
    // Exactly one call to the navigator, and it is that one. A second is a second thing to vet.
    expect(signIn.match(/\bredirect\(/g) ?? []).toEqual(["redirect("]);
  });

  test("the callback URL a provider is handed is always this app's own origin", () => {
    const signIn = AUTH["src/routes/pithy/sign-in.tsx"] ?? "";
    const callbacks = signIn.match(/callbackURL: `[^`]*`/g) ?? [];
    expect(callbacks.length).toBeGreaterThan(0);
    // Interpolated from `origin`, whose only default is the page's own — never a value from config or
    // from a response. The prop exists so a test can render the screen without a window, nothing more.
    // The path half is `callback.tsx`'s own export, not a literal of the same shape — #393. Two
    // strings that agree today is precisely what broke the round trip nobody signed in can test.
    for (const callback of callbacks) expect(callback).toMatch(/callbackURL: `\$\{origin\}\$\{callbackPath\}`/);
    expect(signIn).toContain('import { path as callbackPath } from "./callback";');
    expect(signIn).toContain("props.origin ?? window.location.origin");
  });

  test("turnstile gates the magic-link and OTP forms only, at action login", () => {
    const widget = AUTH["src/turnstile.tsx"] ?? "";
    // The action is read from the projection, never declared here — #377. `@pithy-sh/ui-react`'s
    // `turnstileAction.test.tsx` is the gate that proves the rendered widget carries it.
    expect(widget).toContain("action: turnstileConfig.action");
    expect(widget).not.toMatch(/const ACTION\s*=/);
    expect(widget).toContain("turnstileConfig.token.header");
    expect(widget).toContain("turnstileConfig.token.field");
    // The widget renders inside the email form on both screens, and nowhere near a social button. On
    // the sign-in screen it arrives as `check.widget`, so the assertion is that the host is inside the
    // form and that the social handler attaches nothing.
    const signIn = AUTH["src/routes/pithy/sign-in.tsx"] ?? "";
    const form = signIn.slice(signIn.indexOf('<form className="stack"'), signIn.indexOf("</form>"));
    expect(form).toContain('<div className="auth__check">{check.widget}</div>');
    // Blanked whole, then cut: the shared walk preserves every offset, so the markers found in the
    // raw screen index the blanked one (#439).
    const social = blankComments(signIn).slice(signIn.indexOf("async function social"), signIn.indexOf("if (sent)"));
    expect(social).not.toContain("check.attach");
    expect(AUTH["src/routes/pithy/otp.tsx"]).toContain("<Turnstile");
  });

  test("the widget's gate ships with it, and cannot pass against the literal it exists to catch", () => {
    // #383. Everything else about the action binding is proven by running the gate — here and, once
    // scaffolded, there. What running it cannot prove is that it was *shipped*, and that nothing has
    // since sanded off the two properties it depends on for its whole value.
    const gate = AUTH["src/turnstile.test.tsx"] ?? "";
    expect(gate).not.toBe("");
    // The expectation is a constant invented in the gate, and the mock is authored from that same
    // constant. Assert the real action instead and it passes against a widget that typed one out.
    expect(gate).toMatch(/const CANARY_ACTION = "(?!login")[^"]+";/);
    expect(gate).toContain("action: CANARY_ACTION");
    expect(gate).toContain("expect(rendered?.action).toBe(CANARY_ACTION)");
    // Nothing about the widget's real action may reach it, or it only agrees with itself. The one
    // permitted mention of `login` is the assertion refusing the canary from degenerating onto it.
    expect(gate.match(/"login"/g) ?? []).toEqual(['"login"']);
    expect(gate).toContain('expect(CANARY_ACTION).not.toBe("login")');
    // It runs under the `vitest run` a scaffolded project already has: the starter's node project
    // collects co-located `.tsx` (#245) but gives them no `document`, so the gate names its own
    // environment and the stub installs the package that name resolves to.
    expect(gate).toContain("@vitest-environment happy-dom");
    expect(reactStub.devDependencies["happy-dom"]).toBeTruthy();
  });

  test("the widget is asked to fill the column the stylesheet gives it", () => {
    // #257, both halves. Turnstile renders an iframe with an intrinsic size, so a `width: 100%` host
    // does nothing on its own. `@pithy-sh/ui-react`'s `humanityCheckFit.test.ts` is the gate; this is
    // the half in the file the CLI puts in front of an adopter.
    expect(AUTH["src/turnstile.tsx"]).toContain('size: "flexible"');
    expect(AUTH["src/pithy-screens.css"]).toContain("--pithy-check-min: 300px");
  });

  test("the OTP screen renders otpLength inputs, read from the same config the server validates against", () => {
    const otp = AUTH["src/routes/pithy/otp.tsx"] ?? "";
    expect(otp).toContain('from "../../pithy-config"');
    expect(otp).toContain("Array.from({ length: authConfig.otpLength }");
  });

  test("client-env.d.ts is seeded verbatim, and every template carries every module", async () => {
    // Create-never-overwrite means a later `pithy ui add --payments` cannot come back and add the
    // modules a payments screen reads, so the bare scaffold has to carry them all or a backfilled
    // screen would not typecheck. Support's is here for the same reason: a screen that posts a feedback
    // form is written later, against a file this run is the only chance to write. i18n's is here
    // because `src/pithy-config.tsx` narrows it for every scaffold, composed or not.
    //
    // **What the declarations say is deliberately not asserted here (#392, #398).** This file used to
    // check that the ambient types contained `otpLength: number;` and eleven other strings somebody had
    // once typed — which confirms the file against itself and stays green for exactly the drift that
    // matters, a field a capability's `client` projection stopped emitting.
    //
    // There is nothing left here to drift from. Since #398 the declarations are **generated** from the
    // declared projection types — `@pithy-sh/vite`'s `clientEnvDeclaration.ts` emits the file and
    // `clientEnvDeclaration.test.ts` holds the generator — so a projection losing a field changes the
    // template, rather than disagreeing with it. What is left here is the CLI's own claim: the bytes it
    // writes are that file's, unaltered, in every scaffold.
    const gated = await readFile(join(TEMPLATE_DIR, "client-env.d.ts"), "utf8");
    const modules = [...gated.matchAll(/declare module "virtual:pithy\/([^"]+)"/g)].map((match) => match[1]);
    expect(modules.sort()).toEqual(["auth", "i18n", "payments", "support", "turnstile"]);
    for (const files of [BARE, AUTH, PAY, BOTH]) expect(files["client-env.d.ts"]).toBe(gated);
  });

  test("the payments projection declares no credential, in the ambient types or anywhere else", () => {
    // The capability's own test is the real gate; this is the second half of it, on the consuming side —
    // an ambient declaration naming a secret is a scaffold inviting somebody to project one.
    const ambient = BOTH["client-env.d.ts"] ?? "";
    // One entry per rail's credential block, Lemon Squeezy's included: its API key is account-wide and its
    // store id is account identity, so neither belongs anywhere a browser can read.
    for (const shape of [
      "issuerId",
      "privateKey",
      "serviceAccount",
      "webhookSecret",
      "secretKey",
      "apiKey",
      "storeId",
    ]) {
      expect(ambient, shape).not.toContain(shape);
    }
  });

  test("the declared packages are the verified Vite 8 / React 19 set", () => {
    expect(reactStub.dependencies).toMatchObject({ react: "^19.2.8", "react-dom": "^19.2.8" });
    // @vitejs/plugin-react 6.x is the Vite 8 line; 5.1.x does not support Vite 8.
    expect(reactStub.devDependencies["@vitejs/plugin-react"]).toBe("^6.0.4");
    expect(reactStub.devDependencies.vite).toBe("^8.2.1");
    expect(reactStub.devDependencies["@cloudflare/vite-plugin"]).toBe("^1.48.0");
  });

  test("every @pithy-sh range is that package's OWN version, not core's", async () => {
    // A literal `"^0.0.0"` 404s today for any adopter not linking a checkout in, and goes on 404ing after
    // the scope publishes while every sibling range beside it is correct — so the range is derived.
    //
    // But it is derived from **core's** `PACKAGE_VERSION`, and the package it is written for is
    // `@pithy-sh/vite`. This used to assert exactly that, which restated the bug as an invariant: two
    // packages that version independently, one range. Read each package's own version instead. It is the
    // test below that makes them equal, and that is where the equality belongs.
    for (const [name, range] of Object.entries({ ...reactStub.dependencies, ...reactStub.devDependencies })) {
      if (!name.startsWith("@pithy-sh/")) continue;
      expect(range, name).toBe(kitRange(await declaredVersion(name)));
    }
    // Named, so dropping the package is a deliberate edit rather than a loop that silently sees nothing.
    expect(Object.keys(reactStub.devDependencies)).toContain("@pithy-sh/vite");
    // The other one core's train has to carry, and the one a scaffolded front end cannot build without.
    expect(Object.keys(reactStub.dependencies)).toContain("@pithy-sh/i18n");
  });

  test("every @pithy-sh package the templates import is one the scaffolded worker actually has", async () => {
    // **The gate the i18n work needed and did not have.** `src/client.tsx`, `src/router.tsx` and the bare
    // home screen are all `base` — written on every scaffold — and all three gained an import of
    // `@pithy-sh/i18n`, which the stub declared nowhere. `pithy ui add react` on a project that had not
    // composed i18n wrote a front end whose `vite build` could not resolve it, and nothing here noticed,
    // because every existing assertion about the manifest reads the packages it lists rather than the
    // packages the files need.
    //
    // Three ways a bare specifier resolves in `apps/<worker>/`, and no fourth: the stub declares it, the
    // scaffolded worker already declares it (`@pithy-sh/core`, which `stampWorkerManifest` writes), or the
    // capability whose group the file rides in installs it — `pithy add auth` runs `bun add
    // @pithy-sh/auth`, and `pithy ui add --auth` refuses a worker that has not composed it.
    const declared = new Set(Object.keys({ ...reactStub.dependencies, ...reactStub.devDependencies }));
    /** Written into the worker's own manifest by `pithy init` / `pithy worker add`, before any of this. */
    const worker = new Set(["@pithy-sh/core"]);
    /** The package a capability group's screens may reach, because composing the capability installs it. */
    const byGroup: Record<string, string> = { auth: "@pithy-sh/auth", payments: "@pithy-sh/payments" };

    let seen = 0;
    const invocations = [
      { files: BARE, groups: [] as string[] },
      { files: AUTH, groups: ["auth"] },
      { files: PAY, groups: ["payments"] },
      { files: BOTH, groups: ["auth", "payments"] },
    ];
    for (const { files, groups } of invocations) {
      const allowed = new Set([...declared, ...worker, ...groups.map((group) => byGroup[group] ?? "")]);
      for (const [path, contents] of Object.entries(files)) {
        if (!path.endsWith(".ts") && !path.endsWith(".tsx")) continue;
        // Blanked with the shared stripper, so a docblock naming a package it tells you NOT to import is
        // prose rather than a finding — and so a `//` inside a string cannot switch the scan off (#439).
        for (const match of blankComments(contents).matchAll(/from "(@pithy-sh\/[a-z0-9-]+)/g)) {
          const pkg = match[1] ?? "";
          seen += 1;
          expect(
            allowed.has(pkg),
            `pithy ui add react${groups.map((group) => ` --${group}`).join("")} writes ${path}, which imports ${pkg} — and nothing installs it there`,
          ).toBe(true);
        }
      }
    }
    // The anti-vacuity floor, near-exact rather than comfortable. A regex that stopped matching would
    // pass every invocation above in silence, which is the same green a correct scaffold gives. The four
    // invocations read a hundred and twelve kit imports between them today, and a sweep that found half
    // of them has stopped reading a whole group.
    expect(seen, "the import sweep read nothing — it is passing over an empty set").toBeGreaterThanOrEqual(100);
  });

  test("every package ranged off core's version ships on core's release train", async () => {
    // `react.ts` writes `kitRange(PACKAGE_VERSION)`, core's version, for a sibling. `stampWorkerManifest`
    // forbids exactly that ("there is no honest range to invent for a sibling") and it is right: with
    // `linked` and `fixed` both empty, the first release that touched only core would have written a
    // range `@pithy-sh/vite` never published — #141 again, past publication, where it cannot be fixed by
    // dropping the line.
    //
    // **`fixed`, not `linked`.** Linked packages that are released together take one version; a package
    // not in that release keeps the one it had, so a core-only patch leaves vite behind and the range
    // lies. Fixed packages are always released together at one version, which is the invariant the
    // derivation assumes. Stamping `packages/vite` with a version of its own was the alternative and is
    // more machinery for less: `scripts/stampVersions.ts` stamps capability packages, keyed on
    // `src/capability.ts`, and vite is a Vite plugin with no capability and no runtime that reports a
    // version. It has no reason to carry a constant — only a reason to carry core's number.
    //
    // **`@pithy-sh/i18n` is on the same train for the same reason, and it is the harder case.** It is a
    // capability, and a capability normally versions on its own — its stamped version is what
    // `GET /control-plane/manifest` reports. But every screen `pithy ui add react` writes renders through
    // its React seam, so the stub has to name a range for it, and the CLI has no honest way to read that
    // package's version: it must not depend on an optional capability. Core's number, plus the train, is
    // what makes the range resolvable. The cost is that i18n releases whenever core does — which
    // `updateInternalDependencies: "patch"` already made true, since i18n depends on core.
    const config = JSON.parse(await readFile(join(REPO_ROOT, ".changeset", "config.json"), "utf8")) as {
      fixed?: string[][];
    };
    for (const name of ["@pithy-sh/vite", "@pithy-sh/i18n"]) {
      const group = (config.fixed ?? []).find((entry) => entry.includes(name));
      expect(group, `${name} must be in a Changesets \`fixed\` group with core`).toBeDefined();
      expect(group, name).toContain("@pithy-sh/core");

      // And the guarantee, checked rather than assumed: today every one of them is 0.0.0, and after the
      // first release this is what turns red if the group is ever loosened.
      expect(await declaredVersion(name), name).toBe(PACKAGE_VERSION);
    }
  });
});

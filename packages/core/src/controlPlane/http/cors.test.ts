// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { describe, expect, test } from "vitest";
import { defineCapability } from "../../capability/capability";
import { createBackend } from "../../createBackend";
import { InternalError } from "../../error/pithyError";
import { controlplane } from "../capability";
import { CONTROL_PLANE_HEADER, CONTROL_PLANE_VERSION_CREATED_HEADER, CONTROL_PLANE_VERSION_HEADER } from "../wire";
import { allowedOriginSet, corsSurface, devLoopbackAllows, originOf } from "./cors";
import { requireControlPlane } from "./guard";

/**
 * CORS across the whole control-plane surface (#468).
 *
 * **Nothing here touches D1, and that is an assertion rather than a convenience.** Every case runs
 * against `{ DB: {} }` — an object that is not a database and would throw on the first query. A
 * preflight is answered before any credential is read, so it must cost no database read; running the
 * suite without a database is how that stays true, and the case at the end of §refusal states it out
 * loud by putting a real query beside a preflight and watching only one of them fail.
 *
 * The fixtures below are two capabilities with admin routes of their own, plus an adopter app. All
 * three exist for one reason: the surface under test is *every* composed capability's admin routes,
 * not the seam's own `basePath`, and the adopter's own API is the thing that must stay untouched.
 */

const DASHBOARD = "https://app.pithy.sh";
const SELF_HOSTED = "https://ops.acme.example";
const STRANGER = "https://evil.example";

/** Bindings for every request. `DB` is deliberately not a database — see the header. */
const BINDINGS = { DB: {}, ENVIRONMENT: "prod" };

const INVENTORY_READ_SCOPE = "inventory:things:read";
const VAULT_READ_SCOPE = "vault:secrets:read";

/** A capability contributing one read-only admin route, mounted well away from the seam's basePath. */
const inventory = defineCapability({
  name: "inventory",
  requiredBindings: [],
  adminRoutes: [
    { method: "GET", path: "/inventory/admin/things", scope: INVENTORY_READ_SCOPE, summary: "Every pending thing." },
  ],
  routes: (app) => {
    app.get("/inventory/admin/things", requireControlPlane(INVENTORY_READ_SCOPE), (c) => c.json({ things: [] }));
  },
});

/** A second one, so "one capability happened to work" cannot pass for "the surface is derived". */
const vault = defineCapability({
  name: "vault",
  requiredBindings: [],
  adminRoutes: [
    { method: "GET", path: "/vault/admin/secrets", scope: VAULT_READ_SCOPE, summary: "Every secret, in full." },
  ],
  routes: (app) => {
    app.get("/vault/admin/secrets", requireControlPlane(VAULT_READ_SCOPE), (c) => c.json({ secrets: [] }));
  },
});

/** The adopter's own API: not an admin surface, and never the kit's to decide CORS for. */
const adopterApp = defineCapability({
  name: "app",
  requiredBindings: [],
  routes: (app) => {
    app.get("/api/things", (c) => c.json({ things: [] }));
  },
});

/** The stock composition: no CORS config of any kind passed to `controlplane()`. */
const backend = createBackend({ capabilities: [controlplane(), inventory, vault], app: adopterApp });

/** The same, for a management client the adopter hosts themselves. */
const selfHosted = createBackend({
  capabilities: [controlplane({ issuer: SELF_HOSTED }), inventory, vault],
  app: adopterApp,
});

/** One request at a composed backend. `origin: null` sends no `Origin` header at all. */
function call(
  app: typeof backend,
  path: string,
  {
    method = "OPTIONS",
    origin = DASHBOARD as string | null,
    bindings = BINDINGS as Record<string, unknown>,
  }: { method?: string; origin?: string | null; bindings?: Record<string, unknown> } = {},
) {
  const headers: Record<string, string> = origin === null ? {} : { origin };
  return app.request(`http://worker.example${path}`, { method, headers }, bindings);
}

describe("originOf", () => {
  test("normalizes a URL that is more than an origin", () => {
    expect(originOf("https://ops.acme.example/dash")).toBe(SELF_HOSTED);
    expect(originOf("https://ops.acme.example/")).toBe(SELF_HOSTED);
  });

  test("is null for anything that is not one", () => {
    // `issuer` is a `z.url()` we do not fully control and the request header is not ours at all, so
    // both ends go through this. An `Access-Control-Allow-Origin` carrying a path matches no browser.
    expect(originOf("not-a-url")).toBeNull();
    expect(originOf("")).toBeNull();
    expect(originOf(null)).toBeNull();
    expect(originOf(undefined)).toBeNull();
  });

  test("never echoes an opaque origin back", () => {
    // A sandboxed frame sends the literal string `null`. Echoing it would allow exactly the caller a
    // browser went out of its way to refuse to name.
    expect(originOf("null")).toBeNull();
  });
});

describe("allowedOriginSet", () => {
  test("a stock Worker allows the dashboard and nothing else", () => {
    expect([...allowedOriginSet({ issuer: DASHBOARD, allowedOrigins: [] })]).toEqual([DASHBOARD]);
  });

  test("an entry is additive — it never removes the issuer", () => {
    // The whole reason the key is an array added to `issuer` rather than a list that replaces it. A
    // replacing default would drop the dashboard the first time an adopter wrote one entry.
    const origins = allowedOriginSet({ issuer: DASHBOARD, allowedOrigins: [SELF_HOSTED] });
    expect(origins.has(DASHBOARD)).toBe(true);
    expect(origins.has(SELF_HOSTED)).toBe(true);
  });

  test("dedupes after normalizing, so a trailing slash is not a second entry", () => {
    expect(allowedOriginSet({ issuer: DASHBOARD, allowedOrigins: [`${DASHBOARD}/`] }).size).toBe(1);
  });
});

describe("corsSurface", () => {
  test("is one entry per distinct path, across every capability", () => {
    const surface = corsSurface([
      { adminRoutes: [{ method: "GET", path: "/a", scope: null, summary: "" }] },
      { adminRoutes: [{ method: "POST", path: "/a", scope: null, summary: "" }] },
      { adminRoutes: [{ method: "GET", path: "/b", scope: null, summary: "" }] },
      { adminRoutes: [] },
    ]);
    expect(surface.map((entry) => entry.path)).toEqual(["/a", "/b"]);
    expect(surface[0]?.allowMethods).toBe("GET, POST, OPTIONS");
  });

  test("names content-type only where a method could carry a body", () => {
    const [readOnly] = corsSurface([{ adminRoutes: [{ method: "GET", path: "/a", scope: null, summary: "" }] }]);
    const [writes] = corsSurface([{ adminRoutes: [{ method: "POST", path: "/b", scope: null, summary: "" }] }]);
    expect(readOnly?.allowHeaders).toBe(CONTROL_PLANE_HEADER);
    expect(writes?.allowHeaders).toContain("content-type");
  });
});

describe("the preflight, on a stock Worker", () => {
  test("answers for the dashboard with no configuration at all", async () => {
    const response = await call(backend, "/control-plane/manifest");
    expect(response.status).toBe(204);
    expect(response.headers.get("access-control-allow-origin")).toBe(DASHBOARD);
    expect(await response.text()).toBe("");
  });

  test.each([["/inventory/admin/things"], ["/vault/admin/secrets"]])(
    "answers on a capability's own admin route: %s",
    async (path) => {
      // The criterion that fails for anyone who mounts CORS on `/control-plane/*` and calls it done:
      // the dashboard could ping such a Worker and read nothing from it.
      const response = await call(backend, path);
      expect(response.status).toBe(204);
      expect(response.headers.get("access-control-allow-origin")).toBe(DASHBOARD);
    },
  );

  test("answers on a path carrying a param, whatever the param says", async () => {
    // No param validator sits on this line, deliberately. `ExpireKeyParams.keyId` is `.max(64)`, so a
    // validated preflight would answer 400 `validation/invalid_input` with a body — a different
    // response for a longer id, which is precisely the refusal-by-shape this surface must not have.
    for (const keyId of ["cpk_2026_07", "x".repeat(100)]) {
      const response = await call(backend, `/control-plane/keys/${keyId}/expire`);
      expect(response.status).toBe(204);
      expect(await response.text()).toBe("");
    }
  });

  test("names the token header, and content-type only where a body is plausible", async () => {
    const writes = await call(backend, "/control-plane/keys");
    expect(writes.headers.get("access-control-allow-headers")).toContain(CONTROL_PLANE_HEADER);
    expect(writes.headers.get("access-control-allow-headers")).toContain("content-type");
    expect(writes.headers.get("access-control-allow-methods")).toBe("GET, POST, OPTIONS");

    const readOnly = await call(backend, "/control-plane/manifest");
    expect(readOnly.headers.get("access-control-allow-headers")).toBe(CONTROL_PLANE_HEADER);
    expect(readOnly.headers.get("access-control-allow-methods")).toBe("GET, OPTIONS");
  });

  test("lets a browser cache it, so the dashboard does not preflight every call", async () => {
    expect((await call(backend, "/control-plane/manifest")).headers.get("access-control-max-age")).toBe("600");
  });

  test("and the adopter can turn that cache off while working an allow-list out", async () => {
    const noCache = createBackend({
      capabilities: [controlplane({ corsMaxAgeSeconds: 0 }), inventory, vault],
      app: adopterApp,
    });
    expect((await call(noCache, "/control-plane/manifest")).headers.get("access-control-max-age")).toBe("0");
  });
});

describe("the refusal", () => {
  test("an unlisted origin gets the same 204 and the same empty body, minus the one header", async () => {
    const allowed = await call(backend, "/control-plane/manifest");
    const refused = await call(backend, "/control-plane/manifest", { origin: STRANGER });

    expect(refused.status).toBe(allowed.status);
    expect(await refused.text()).toBe(await allowed.text());
    expect(refused.headers.get("access-control-allow-origin")).toBeNull();
  });

  test("says nothing about why, in the body or in a code", async () => {
    // A 403 here would read better in a log and would also be an oracle over the allow-list, on the one
    // response this surface answers before reading a credential.
    const refused = await call(backend, "/control-plane/manifest", { origin: STRANGER });
    expect(await refused.text()).not.toContain("controlplane/");
    expect(refused.headers.get("access-control-allow-methods")).toBeNull();
  });

  test("a request with no Origin at all is answered the same way", async () => {
    const response = await call(backend, "/control-plane/manifest", { origin: null });
    expect(response.status).toBe(204);
    expect(response.headers.get("access-control-allow-origin")).toBeNull();
  });

  test("costs no database read, while a real call on the same backend needs one", async () => {
    // `DB` is `{}`. The preflight is answered anyway; `GET /control-plane/ping` reaches for the
    // connection row and cannot. That contrast is the assertion: it fails the day something moves the
    // allow-list behind a query, which is the change that would turn a preflight into an oracle.
    expect((await call(backend, "/control-plane/ping")).status).toBe(204);
    const real = await call(backend, "/control-plane/ping", { method: "GET" });
    expect(real.status).toBeGreaterThanOrEqual(400);
  });
});

describe("the actual response", () => {
  test("carries the allow-origin, so a denial can be read rather than guessed at", async () => {
    // Without this the dashboard sees an opaque network error where the Worker sent a perfectly clear
    // `controlplane/*` code, and reports a healthy Worker as an unreachable one.
    const response = await call(backend, "/control-plane/manifest", { method: "GET" });
    expect(response.status).toBe(401);
    expect(response.headers.get("access-control-allow-origin")).toBe(DASHBOARD);
  });

  test("exposes both version headers, and does not bother on the preflight", async () => {
    const real = await call(backend, "/control-plane/manifest", { method: "GET" });
    const exposed = real.headers.get("access-control-expose-headers") ?? "";
    expect(exposed).toContain(CONTROL_PLANE_VERSION_HEADER);
    expect(exposed).toContain(CONTROL_PLANE_VERSION_CREATED_HEADER);

    expect((await call(backend, "/control-plane/manifest")).headers.get("access-control-expose-headers")).toBeNull();
  });
});

describe("Vary", () => {
  test.each([
    ["an allowed preflight", { origin: DASHBOARD, method: "OPTIONS" }],
    ["a refused preflight", { origin: STRANGER, method: "OPTIONS" }],
    ["the real response", { origin: DASHBOARD, method: "GET" }],
  ])("names Origin on %s", async (_label, init) => {
    // On every response this layer touches, echoing or not: the two answers differ by one header, so a
    // shared cache keyed on the URL alone would hand one origin's allow-origin to another.
    const response = await call(backend, "/control-plane/manifest", init);
    expect(response.headers.get("vary")).toContain("Origin");
  });
});

describe("credentials", () => {
  test.each([
    ["an allowed preflight", { origin: DASHBOARD, method: "OPTIONS" }],
    ["a refused preflight", { origin: STRANGER, method: "OPTIONS" }],
    ["the real response", { origin: DASHBOARD, method: "GET" }],
  ])("are never allowed, on %s", async (_label, init) => {
    // The token rides a header and this surface sets no cookie. The day someone wants cookies here it
    // is a decision with a threat model behind it, not a header somebody added to make a demo work.
    const response = await call(backend, "/control-plane/manifest", init);
    expect(response.headers.get("access-control-allow-credentials")).toBeNull();
  });
});

describe("the adopter's own app", () => {
  test("gains no CORS header, on any method", async () => {
    const real = await call(backend, "/api/things", { method: "GET" });
    expect(real.status).toBe(200);
    expect(real.headers.get("access-control-allow-origin")).toBeNull();
    expect(real.headers.get("vary")).toBeNull();
  });

  test("still 404s an OPTIONS the way it did before", async () => {
    expect((await call(backend, "/api/things")).status).toBe(404);
  });

  test("a subpath of an admin route is not covered either", async () => {
    // `app.use` on a literal path does not match subpaths, which is what makes "nothing outside the
    // surface" structural rather than a check that could be got wrong.
    expect((await call(backend, "/control-plane/keys/extra/deeper")).status).toBe(404);
  });
});

describe("a self-hosted management client", () => {
  test("follows the configured issuer, not the connection row", async () => {
    const mine = await call(selfHosted, "/control-plane/manifest", { origin: SELF_HOSTED });
    expect(mine.status).toBe(204);
    expect(mine.headers.get("access-control-allow-origin")).toBe(SELF_HOSTED);

    // And the hosted dashboard is not quietly allowed alongside it. An adopter who wants both says so
    // with `allowedOrigins`; nothing here decides it for them.
    const hosted = await call(selfHosted, "/control-plane/manifest", { origin: DASHBOARD });
    expect(hosted.headers.get("access-control-allow-origin")).toBeNull();
  });

  test("adding an origin keeps the issuer working", async () => {
    const both = createBackend({
      capabilities: [controlplane({ allowedOrigins: [SELF_HOSTED] }), inventory, vault],
      app: adopterApp,
    });
    for (const origin of [DASHBOARD, SELF_HOSTED]) {
      const response = await call(both, "/control-plane/manifest", { origin });
      expect(response.headers.get("access-control-allow-origin")).toBe(origin);
    }
  });
});

describe("local dev", () => {
  /** A local Worker. Note what is NOT here: no origin var of any kind. That is the point. */
  const DEV = { DB: {}, ENVIRONMENT: "dev" };

  test("allows a console on this machine, with no configuration and no port known in advance", async () => {
    // The dev port allocator picks the console's port per feature, so no value an adopter could write
    // into `allowedOrigins` stays true across checkouts. In dev the seam allows this machine instead.
    const response = await call(backend, "/control-plane/manifest", {
      origin: "http://localhost:5173",
      bindings: DEV,
    });
    expect(response.status).toBe(204);
    expect(response.headers.get("access-control-allow-origin")).toBe("http://localhost:5173");
  });

  test("does none of that outside dev", async () => {
    // One word different in the bindings. A loopback origin is never allowed in staging or production,
    // where the allow-list is static config and nothing else.
    for (const environment of ["staging", "prod"]) {
      const response = await call(backend, "/control-plane/manifest", {
        origin: "http://localhost:5173",
        bindings: { ...DEV, ENVIRONMENT: environment },
      });
      expect(response.headers.get("access-control-allow-origin")).toBeNull();
    }
  });

  test("and never reaches past this machine, even in dev", async () => {
    const response = await call(backend, "/control-plane/manifest", {
      origin: "https://someone-elses.example",
      bindings: DEV,
    });
    expect(response.headers.get("access-control-allow-origin")).toBeNull();
  });

  test("grants nothing on its own — the route still wants a token", async () => {
    // The allowance lets a local page *read a reply it could already provoke*. It authenticates nobody.
    const response = await call(backend, "/control-plane/manifest", {
      method: "GET",
      origin: "http://localhost:5173",
      bindings: DEV,
    });
    expect(response.status).toBe(401);
  });

  test.each([
    ["http://localhost:5173", true],
    ["http://127.0.0.1:8787", true],
    ["http://[::1]:8788", true],
    ["https://someone-elses.example", false],
    ["http://localhost.evil.example", false], // the classic near-miss: a real host that reads as local
    ["http://127.0.0.1.evil.example", false],
  ])("devLoopbackAllows(%j) is %j in dev", (origin, expected) => {
    expect(devLoopbackAllows({ ENVIRONMENT: "dev" }, origin)).toBe(expected);
  });

  test("and is false the moment the environment is not dev", () => {
    expect(devLoopbackAllows({ ENVIRONMENT: "prod" }, "http://localhost:5173")).toBe(false);
    expect(devLoopbackAllows({}, "http://localhost:5173")).toBe(false);
  });
});

describe("registration order", () => {
  /** A capability whose middleware refuses every request — `@pithy-sh/vector`'s provisionGuard, in miniature. */
  const gatekeeper = defineCapability({
    name: "gatekeeper",
    requiredBindings: [],
    middleware: [
      (app) => {
        app.use("*", () => {
          throw new InternalError({ message: "This Worker is not provisioned.", detail: "fixture" });
        });
      },
    ],
  });

  /** Composed FIRST, which is the case that used to lose. */
  const blocked = createBackend({
    capabilities: [gatekeeper, controlplane(), inventory, vault],
    app: adopterApp,
  });

  test("a capability composed first that refuses everything cannot swallow the preflight", async () => {
    const response = await call(blocked, "/control-plane/manifest");
    expect(response.status).toBe(204);
    expect(response.headers.get("access-control-allow-origin")).toBe(DASHBOARD);
  });

  test("and its refusal stays readable, which is the entire point of the change", async () => {
    // Without this the dashboard meets a misprovisioned Worker as an opaque `fetch` TypeError — the
    // failure #468 exists to remove, arriving on the one misconfiguration where the operator most
    // needs to read the real message.
    const response = await call(blocked, "/control-plane/manifest", { method: "GET" });
    expect(response.status).toBe(500);
    expect(response.headers.get("access-control-allow-origin")).toBe(DASHBOARD);
  });

  test("marks the real response readable on a capability composed before the seam", async () => {
    // Composition order is the adopter's. CORS is registered in `createBackend` ahead of every
    // capability's middleware precisely so none of this depends on where they listed `controlplane()`.
    const seamLast = createBackend({ capabilities: [inventory, vault, controlplane()], app: adopterApp });
    const response = await call(seamLast, "/inventory/admin/things", { method: "GET" });
    expect(response.headers.get("access-control-allow-origin")).toBe(DASHBOARD);
  });
});

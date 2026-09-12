// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { noopEmit } from "@pithy-sh/core/src/audit/recorder";
import type { PithyHonoEnv } from "@pithy-sh/core/src/capability/capability";
import { pithyErrorHandler } from "@pithy-sh/core/src/error/http";
import { pathParams, uncoveredParamRoutes } from "@pithy-sh/core/src/http/routeContract";
import { noopLogger } from "@pithy-sh/core/src/logger/logger";
import { Hono } from "hono";
import { describe, expect, test } from "vitest";
import { OrganizationConfig } from "../config/config";
import { INVITATION_ACCEPT_SEGMENT } from "../mail/invitation";
import type { OwnershipRoles } from "../ownership/ownership";
import { defineRoles } from "../roles/roles";
import { ORGANIZATION_ROUTES, registerOrganizationRoutes } from "./routes";
import {
  ORGANIZATION_ACCOUNTS_READ_SCOPE,
  ORGANIZATION_CONTROL_PLANE_SCOPES,
  ORGANIZATION_MEMBERS_READ_SCOPE,
  organizationAdminRoutes,
} from "./scopes";

/**
 * The whole mounted surface, pinned — and the ordering properties that no inspection of `app.routes`
 * could establish.
 *
 * **Three different kinds of check live here, and they catch three different mistakes.**
 *
 * The *declaration* checks compare {@link ORGANIZATION_ROUTES} against what Hono actually mounted, in
 * both directions. The registry is the only record of a route's verification strategy, so a route added
 * without an entry is a route whose gate nobody declared — and an entry naming a route nobody mounts is
 * a promise to a client that 404s.
 *
 * The *behavioral* checks send real requests with no credential at all. A middleware count would call a
 * bare `zValidator` a guard; only the answer says which gate ran. That is how the CSRF ordering is
 * asserted: `requireSameOrigin()` denies with `auth/forbidden` when nothing published an origin policy,
 * so a mutating route that lost it answers `auth/invalid_token` from the session gate instead and this
 * file fails. **That is the test the brief asks for** — a mutating route without the same-origin guard
 * is caught, rather than trusted to review.
 *
 * The *anti-vacuity* check pins the exact sorted list. A route added deliberately is one line here; a
 * route added by accident is a failure.
 *
 * Two wirings are exercised throughout, because the ownership routes mount only where a project declares
 * the pair a transfer moves — see `routes.ts`. A surface that is conditional is a surface with two
 * shapes, and pinning one of them is pinning half a contract.
 */

const catalog = defineRoles({
  powers: ["connections:read"],
  roles: {
    member: ["organization:read", "connections:read"],
    admin: ["organization:read", "connections:read", "organization:manage"],
    owner: [
      "organization:read",
      "connections:read",
      "organization:manage",
      "members:manage",
      "billing:manage",
      "organization:delete",
    ],
  },
  administrativePower: "organization:manage",
  nests: ["member", "admin", "owner"],
  unassignable: ["owner"],
});

type Role = (typeof catalog.roles)[number];

const OWNERSHIP: OwnershipRoles<Role> = { confers: "owner", demotesTo: "admin" };

const CONFIG = OrganizationConfig.parse({ baseUrl: "https://app.example.test" });

/**
 * The routes, mounted the way `createBackend` mounts them.
 *
 * The error handler and the seeded request variables are not decoration: `createBackend` installs
 * `pithyErrorHandler` and seeds `c.var` on every real deployment, so a bare Hono app would answer 500
 * where production answers 403. `sameOrigin` and `controlPlaneVerifier` are null, as they are in a
 * Worker that composed neither — which is exactly the state both seams are meant to deny in, and
 * therefore the one worth sending requests at.
 */
function makeApp(options: { basePath?: string; ownership?: OwnershipRoles<Role> } = {}) {
  const app = new Hono<PithyHonoEnv>();
  app.onError(pithyErrorHandler);
  app.use("*", async (c, next) => {
    c.set("auth", null);
    c.set("controlPlane", null);
    c.set("controlPlaneVerifier", null);
    c.set("sameOrigin", null);
    c.set("emit", noopEmit);
    c.set("log", noopLogger);
    await next();
  });
  registerOrganizationRoutes({
    catalog,
    config: CONFIG,
    basePath: options.basePath,
    ownership: options.ownership ?? OWNERSHIP,
  })(app);
  return app;
}

/** The app with no transfer wired — a catalog that excludes nothing has no ownership to move. */
function makeAppWithoutOwnership(basePath?: string) {
  const app = new Hono<PithyHonoEnv>();
  app.onError(pithyErrorHandler);
  app.use("*", async (c, next) => {
    c.set("auth", null);
    c.set("controlPlane", null);
    c.set("controlPlaneVerifier", null);
    c.set("sameOrigin", null);
    c.set("emit", noopEmit);
    c.set("log", noopLogger);
    await next();
  });
  registerOrganizationRoutes({ catalog, config: CONFIG, basePath })(app);
  return app;
}

const BASE = CONFIG.basePath;

/**
 * Every route Hono actually mounted, method included and middleware excluded.
 *
 * `app.routes` lists middleware too, as `ALL` on the pattern it was registered against — the
 * `app.use("*")` above is one. Filtered by method rather than by a path prefix, because a prefix filter
 * would silently drop a route mounted under a base somebody typed wrong, which is precisely the drift
 * this file exists to catch.
 */
function mounted(app: Hono<PithyHonoEnv>): { method: string; path: string }[] {
  const seen = new Map<string, { method: string; path: string }>();
  for (const route of app.routes) {
    if (route.method === "ALL") continue;
    seen.set(`${route.method} ${route.path}`, { method: route.method, path: route.path });
  }
  return [...seen.values()];
}

function mountedKeys(app: Hono<PithyHonoEnv>): string[] {
  return mounted(app)
    .map((route) => `${route.method} ${route.path}`)
    .sort();
}

/** A declaration's fully mounted path. An empty relative path is the base itself. */
function fullPath(path: string, base = BASE): string {
  return `${base}${path}`;
}

/** A request with no credential of any kind, with every path parameter filled in. */
async function callWithNothing(
  app: Hono<PithyHonoEnv>,
  route: { method: string; path: string },
  body?: string,
): Promise<Response> {
  const path = route.path
    .replace(":membershipId", "11111111-1111-4111-8111-111111111111")
    .replace(":invitationId", "22222222-2222-4222-8222-222222222222")
    .replace(":organizationId", "33333333-3333-4333-8333-333333333333")
    .replace(":token", "a-token");
  return await app.request(path, {
    method: route.method,
    ...(body === undefined ? {} : { body, headers: { "content-type": "application/json" } }),
  });
}

async function errorCode(response: Response): Promise<string | undefined> {
  const payload = (await response.json()) as { error?: { code?: string } };
  return payload.error?.code;
}

describe("the declared surface and the mounted one are the same surface", () => {
  test("every declaration is mounted, and nothing is mounted that was not declared", () => {
    const keys = new Set(mountedKeys(makeApp()));
    for (const route of ORGANIZATION_ROUTES) {
      expect(keys.has(`${route.method} ${fullPath(route.path)}`), `${route.method} ${route.path} is declared`).toBe(
        true,
      );
    }
    // Method *and* path. Comparing paths alone would let an extra method on an already-declared path
    // through — a `POST /current/members` beside the declared `GET` would be invisible, and since the
    // registry is the only record of a route's verification strategy, invisible here is undeclared
    // everywhere.
    const declared = new Set(ORGANIZATION_ROUTES.map((route) => `${route.method} ${fullPath(route.path)}`));
    for (const key of keys) {
      expect(declared.has(key), `${key} is mounted but not declared in ORGANIZATION_ROUTES`).toBe(true);
    }
  });

  test("with no transfer wired, exactly the three ownership routes are absent", () => {
    const withOwnership = new Set(mountedKeys(makeApp()));
    const without = new Set(mountedKeys(makeAppWithoutOwnership()));
    const missing = [...withOwnership].filter((key) => !without.has(key)).sort();
    expect(missing).toEqual([
      `DELETE ${BASE}/current/ownership`,
      `GET ${BASE}/current/ownership`,
      `POST ${BASE}/current/ownership`,
      `POST ${BASE}/ownership/accept`,
    ]);
    // And they are the ones the registry marks as such — the two lists agree rather than happening to
    // have the same length.
    expect(
      ORGANIZATION_ROUTES.filter((route) => route.ownership)
        .map((route) => `${route.method} ${fullPath(route.path)}`)
        .sort(),
    ).toEqual(missing);
    // Nothing else moved. A conditional mount that also dropped an unrelated route would pass the check
    // above and fail here.
    expect([...without].filter((key) => !withOwnership.has(key))).toEqual([]);
  });

  test("the whole mounted surface, pinned", () => {
    // Anti-vacuity, exact rather than a floor. A route added on purpose is one line here; a route added
    // by accident is a failing test with a name on it.
    expect(mountedKeys(makeApp())).toEqual([
      `DELETE ${BASE}/current`,
      `DELETE ${BASE}/current/invitations/:invitationId`,
      `DELETE ${BASE}/current/members/:membershipId`,
      `DELETE ${BASE}/current/ownership`,
      `GET ${BASE}`,
      `GET ${BASE}/admin/organizations`,
      `GET ${BASE}/admin/organizations/:organizationId/members`,
      `GET ${BASE}/current`,
      `GET ${BASE}/current/invitations`,
      `GET ${BASE}/current/members`,
      `GET ${BASE}/current/ownership`,
      `GET ${BASE}/invitations/:token`,
      `GET ${BASE}/marks/organization/:organizationId`,
      `GET ${BASE}/members/:membershipId/image`,
      `PATCH ${BASE}/current`,
      `PATCH ${BASE}/current/members/:membershipId`,
      `POST ${BASE}`,
      `POST ${BASE}/acting`,
      `POST ${BASE}/current/invitations`,
      `POST ${BASE}/current/invitations/:invitationId/resend`,
      `POST ${BASE}/current/members/leave`,
      `POST ${BASE}/current/ownership`,
      `POST ${BASE}/invitations/accept`,
      `POST ${BASE}/ownership/accept`,
    ]);
  });

  test("the routes follow a moved basePath, all of them", () => {
    const moved = mountedKeys(makeApp({ basePath: "/accounts" }));
    expect(moved).toHaveLength(ORGANIZATION_ROUTES.length);
    for (const key of moved) {
      expect(key.endsWith(" /accounts") || key.includes(" /accounts/"), key).toBe(true);
    }
    // The default mount is genuinely gone, rather than both being registered. Compared on the *path*
    // rather than on the whole key, because `/accounts/admin/organizations` contains the default base as
    // a substring and a `.includes` would call the move a success in both directions.
    for (const route of mounted(makeApp({ basePath: "/accounts" }))) {
      expect(route.path === BASE || route.path.startsWith(`${BASE}/`), route.path).toBe(false);
    }
  });
});

describe("the request contract: every path param is validated", () => {
  test("no organization route reads a path param it never declared a schema for", async () => {
    const uncovered = await uncoveredParamRoutes(makeApp() as unknown as Hono<never>);
    expect(
      uncovered,
      `These routes declare path params but register no zValidator("param", …):\n${uncovered
        .map((route) => `  ${route.method} ${route.path} — :${route.params.join(", :")}`)
        .join("\n")}\nAdd a param schema in src/http/schemas.ts and declare it on the route line.`,
    ).toEqual([]);
  });

  test("the param-bearing routes are the five that name a thing, and nothing else", () => {
    const paramPaths = [
      ...new Set(
        mounted(makeApp())
          .filter((route) => pathParams(route.path).length > 0)
          .map((route) => route.path),
      ),
    ].sort();
    expect(paramPaths).toEqual([
      `${BASE}/admin/organizations/:organizationId/members`,
      `${BASE}/current/invitations/:invitationId`,
      `${BASE}/current/invitations/:invitationId/resend`,
      `${BASE}/current/members/:membershipId`,
      `${BASE}/invitations/:token`,
      `${BASE}/marks/organization/:organizationId`,
      `${BASE}/members/:membershipId/image`,
    ]);
    // Not one of them names an organization inside the acting surface. The selection is session state,
    // so a scoped route has no segment that could carry another tenant's id; the two that do name one
    // are the chooser's mark and the management roster, and both say so at the mount.
    for (const path of paramPaths) {
      if (path.includes(":organizationId")) {
        expect(path.startsWith(`${BASE}/admin/`) || path.startsWith(`${BASE}/marks/`), path).toBe(true);
      }
    }
  });
});

describe("the gates, as the router behaves rather than as anything declares", () => {
  test("every mutating route runs requireSameOrigin FIRST", async () => {
    // The ordering assertion the brief asks for, and the one `app.routes` cannot make. With no capability
    // publishing an origin policy the gate denies with `auth/forbidden`; a mutating route that lost the
    // guard would fall through to the session gate and answer `auth/invalid_token` instead, which is a
    // different code and a failing test rather than a silent CSRF hole.
    for (const route of ORGANIZATION_ROUTES.filter((entry) => entry.mutating)) {
      const response = await callWithNothing(makeApp(), {
        method: route.method,
        path: fullPath(route.path),
      });
      expect(response.status, `${route.method} ${route.path}`).toBe(403);
      expect(await errorCode(response), `${route.method} ${route.path}`).toBe("auth/forbidden");
    }
  });

  test("and it runs before the validator, so a malformed body is still 403 and not 400", async () => {
    // A validator ahead of a gate turns a refusal into a 400 and tells an unverified caller which bodies
    // were well-formed. On a tenancy surface that is a live probe of the membership model.
    for (const route of ORGANIZATION_ROUTES.filter((entry) => entry.mutating && entry.method !== "DELETE")) {
      const response = await callWithNothing(
        makeApp(),
        { method: route.method, path: fullPath(route.path) },
        JSON.stringify({ nonsense: true, role: 42, organizationId: null }),
      );
      expect(response.status, `${route.method} ${route.path}`).toBe(403);
    }
  });

  test("every read gated by a session refuses an anonymous caller", async () => {
    // Not merely "is not 200". The code says the *session* gate answered, so a read that lost
    // `requireOrganization()`/`requireAuth()` and reached its handler fails here rather than serving one
    // tenant's roster to nobody in particular.
    for (const route of ORGANIZATION_ROUTES.filter((entry) => !entry.mutating && entry.strategy === "session")) {
      const response = await callWithNothing(makeApp(), { method: route.method, path: fullPath(route.path) });
      expect(response.status, `${route.method} ${route.path}`).toBe(401);
      expect(await errorCode(response), `${route.method} ${route.path}`).toBe("auth/invalid_token");
    }
  });

  test("every control-plane route actually runs its scope guard", async () => {
    // The real gate. `requireControlPlane` answers 403 `controlplane/not_connected` only if it genuinely
    // ran; a route that lost it would fall through to a handler and fail differently — or succeed.
    for (const route of ORGANIZATION_ROUTES.filter((entry) => entry.strategy === "control-plane")) {
      const response = await callWithNothing(makeApp(), { method: route.method, path: fullPath(route.path) });
      expect(response.status, `${route.method} ${route.path}`).toBe(403);
      expect(await errorCode(response), `${route.method} ${route.path}`).toBe("controlplane/not_connected");
    }
  });

  test("and before its query validator, so an out-of-range limit is not reported to an unverified caller", async () => {
    const response = await makeApp().request(`${BASE}/admin/organizations?limit=99999`);
    expect(response.status).toBe(403);
    expect(await errorCode(response)).toBe("controlplane/not_connected");
  });

  test("the one public route is genuinely public, and it is the only one", async () => {
    // It reaches its handler with no credential — which, with no `DB` binding on this app, is a stated
    // wiring failure rather than a refusal. That distinction is the proof: every other route answers
    // before a handler runs.
    const publicRoutes = ORGANIZATION_ROUTES.filter((entry) => entry.strategy === "public");
    expect(publicRoutes.map((route) => `${route.method} ${route.path}`)).toEqual(["GET /invitations/:token"]);
    const response = await callWithNothing(makeApp(), {
      method: "GET",
      path: fullPath("/invitations/:token"),
    });
    expect(response.status).toBe(500);
    expect(await errorCode(response)).toBe("core/internal");
  });
});

describe("the surface a client is told about", () => {
  test("the accept link in every sent invitation resolves to a mounted route", () => {
    // `invitationAcceptUrl` mints `{base}/{segment}/{token}` and an already-sent mail cannot be moved,
    // so nothing but this assertion stands between a renamed route and a dead link in somebody's inbox.
    const paths = new Set(mounted(makeApp()).map((route) => route.path));
    expect(paths.has(`${BASE}/${INVITATION_ACCEPT_SEGMENT}/:token`)).toBe(true);
    expect(paths.has(`${BASE}/${INVITATION_ACCEPT_SEGMENT}/accept`)).toBe(true);
  });

  test("every advertised admin route is mounted, with its declared scope", () => {
    const keys = new Set(mountedKeys(makeApp()));
    for (const route of organizationAdminRoutes(BASE)) {
      expect(keys.has(`${route.method} ${route.path}`), route.path).toBe(true);
      expect(ORGANIZATION_CONTROL_PLANE_SCOPES, route.path).toContain(route.scope);
      // The scope a route demands and the scope the manifest advertises are the same constant, read
      // from the registry rather than from the string in the manifest entry.
      const declared = ORGANIZATION_ROUTES.find(
        (entry) => entry.method === route.method && fullPath(entry.path) === route.path,
      );
      expect(declared?.scope, route.path).toBe(route.scope);
    }
  });

  test("and nothing is mounted behind the control-plane gate that the manifest does not declare", async () => {
    const advertised = new Set(organizationAdminRoutes(BASE).map((route) => `${route.method} ${route.path}`));
    const gated: string[] = [];
    for (const route of mounted(makeApp())) {
      const response = await callWithNothing(makeApp(), route, route.method === "GET" ? undefined : "{}");
      if (response.status !== 403) continue;
      if ((await errorCode(response)) === "controlplane/not_connected") gated.push(`${route.method} ${route.path}`);
    }
    // Read from behavior, because a set computed from the declaration could not observe a route mounted
    // with `requireControlPlane` and never declared — which is the whole failure this exists for.
    expect(gated.sort()).toEqual([...advertised].sort());
  });

  test("the advertised paths follow a moved basePath", () => {
    for (const route of organizationAdminRoutes("/accounts")) {
      expect(route.path.startsWith("/accounts/admin/")).toBe(true);
    }
    expect(new Set(mountedKeys(makeApp({ basePath: "/accounts" })))).toContain(`GET /accounts/admin/organizations`);
  });

  test("the two management scopes are separate, and neither is a write", () => {
    // One `organization:admin` flag would mean a credential issued to find the right tenant also carried
    // every customer's address. `scopeCovers` matches exactly, with no prefix rule.
    expect(new Set([ORGANIZATION_ACCOUNTS_READ_SCOPE, ORGANIZATION_MEMBERS_READ_SCOPE]).size).toBe(2);
    expect(ORGANIZATION_CONTROL_PLANE_SCOPES).toHaveLength(2);
    for (const route of ORGANIZATION_ROUTES.filter((entry) => entry.strategy === "control-plane")) {
      expect(route.method, route.path).toBe("GET");
      expect(route.mutating, route.path).toBe(false);
    }
  });

  test("no admin route is a member route, and no member route is an admin one", () => {
    const advertised = new Set(organizationAdminRoutes(BASE).map((route) => route.path));
    for (const route of ORGANIZATION_ROUTES) {
      const isAdmin = fullPath(route.path).startsWith(`${BASE}/admin/`);
      expect(advertised.has(fullPath(route.path)), route.path).toBe(isAdmin);
      expect(route.strategy === "control-plane", route.path).toBe(isAdmin);
    }
  });
});

describe("the registry says what it must", () => {
  test("every route names a strategy, and only the kit's own powers are demanded", () => {
    for (const route of ORGANIZATION_ROUTES) {
      expect(route.strategy, route.path).toBeTruthy();
      if (route.power) expect(catalog.powers, route.path).toContain(route.power);
      if (route.scope) expect(route.strategy, route.path).toBe("control-plane");
    }
  });

  test("no route is declared twice", () => {
    const keys = ORGANIZATION_ROUTES.map((route) => `${route.method} ${route.path}`);
    expect(new Set(keys).size).toBe(keys.length);
  });

  test("the routes entitled by something other than a power are exactly these seven", () => {
    // Every route that acts inside the account in force asks the matrix. These do not, and each is
    // entitled by something a power could not express:
    //
    //   `GET {base}` and `POST {base}` — span organizations, or precede one. There is no role to read.
    //   `POST /acting` — the membership *is* the entitlement, proved in the write that records the choice.
    //   `POST /current/members/leave` — being yourself. A power to stop holding somebody else's access
    //     would be a power somebody could take away.
    //   `POST /invitations/accept` — holding an offer made to your own address.
    //   `POST /ownership/accept` — being the nominee, proved against the standing offer. A caller holding
    //     every power in the catalog cannot accept an offer made to somebody else.
    //   `GET /marks/organization/:organizationId` — a membership in the organization it names, and no
    //     more: the mark is drawn on the chooser, where nothing is in force and `organization:read` would
    //     be a question about an account nobody has selected.
    //   `GET /current/ownership` — membership, because the nominee is by definition the person who does
    //     not hold the account yet. Gating the read on `billing:manage` would hide the offer from the
    //     only caller it was made for.
    //
    // A ninth entry here is a route that let somebody in on a rule nobody wrote down.
    const ungated = ORGANIZATION_ROUTES.filter((route) => route.strategy === "session" && !route.power).map(
      (route) => `${route.method} ${route.path}`,
    );
    expect(ungated.sort()).toEqual([
      "GET ",
      "GET /current/ownership",
      "GET /marks/organization/:organizationId",
      "POST ",
      "POST /acting",
      "POST /current/members/leave",
      "POST /invitations/accept",
      "POST /ownership/accept",
    ]);
  });
});

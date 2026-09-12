// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import type { D1Database } from "@cloudflare/workers-types";
import { zValidator } from "@hono/zod-validator";
import { type AuthDatabase, authDatabase } from "@pithy-sh/auth/src/data/tables";
import type { PithyHonoEnv } from "@pithy-sh/core/src/capability/capability";
import { requireControlPlane } from "@pithy-sh/core/src/controlPlane/http/guard";
import type { ControlPlaneScope } from "@pithy-sh/core/src/controlPlane/scope/scope";
import { MAX_PAGE_SIZE } from "@pithy-sh/core/src/data/cursor";
import { InternalError, NotFoundError, UnauthorizedError } from "@pithy-sh/core/src/error/pithyError";
import { requireSameOrigin } from "@pithy-sh/core/src/http/sameOrigin";
import { validationHook } from "@pithy-sh/core/src/http/validation";
import type { VerificationStrategy } from "@pithy-sh/core/src/http/verification";
import { STORED_IMAGE_HEADERS, storedImageBytes } from "@pithy-sh/core/src/image/storedImage";
import type { Context, Hono, MiddlewareHandler } from "hono";
import { chooseActing, listActable, noSuchOrganization, resolveActing } from "../acting/acting";
import { OrganizationAuditActions } from "../audit/actions";
import { correlation, type OrganizationAuditEvent, recordOrganizationAction } from "../audit/emit";
import type { OrganizationConfig } from "../config/config";
import { Invitation } from "../data/invitation";
import { Organization } from "../data/organization";
import {
  INVITATIONS_TABLE,
  MEMBERSHIPS_TABLE,
  ORGANIZATIONS_TABLE,
  type OrganizationDatabase,
  organizationDatabase,
} from "../data/tables";
import { OrganizationForbiddenError, OrganizationInvitationInvalidError } from "../error/errors";
import {
  acceptInvitation,
  invite,
  listInvitations,
  requireInvitationInOrganization,
  resendInvitation,
  withdrawInvitation,
} from "../invite/invite";
import { invitationDigest } from "../invite/token";
import { type EnqueueInvitation, invitationAcceptUrl, sendInvitationMail } from "../mail/invitation";
import {
  changeRole,
  leaveOrganization,
  listMembers,
  removeMember,
  requireMayAssign,
  requireMembershipInOrganization,
} from "../members/members";
import {
  acceptNomination,
  nominate,
  type OwnershipRoles,
  standingNomination,
  withdrawNomination,
} from "../ownership/ownership";
import { MEMBERS_PATH_SEGMENT, readPeople } from "../people/people";
import { createOrganization, deleteOrganization, renameOrganization, setLogo } from "../provision/provision";
import type { KitPower, RoleCatalog } from "../roles/roles";
import { type OrganizationGuardDeps, type OrganizationHonoEnv, requireOrganization, requirePower } from "./guard";
import type {
  AcceptInvitationResponse,
  AdminMembersResponse,
  AdminOrganizationsResponse,
  DeletedOrganizationResponse,
  InvitationsResponse,
  InviteResponse,
  MemberRoleResponse,
  MembersResponse,
  NominationResponse,
  OrganizationRecordResponse,
  OrganizationResponse,
  OrganizationsResponse,
  RemovedMemberResponse,
  TransferResponse,
  WithdrawnInvitationResponse,
} from "./responses";
import {
  AcceptInvitation,
  AdminListQuery,
  AdminOrganizationParam,
  ChangeRole,
  ChooseOrganization,
  CreateOrganization,
  InvitationParam,
  InvitationTokenParam,
  InviteMember,
  MemberMarkParam,
  MembershipParam,
  NominateOwner,
  OrganizationMarkParam,
  UpdateOrganization,
} from "./schemas";
import { ORGANIZATION_ACCOUNTS_READ_SCOPE, ORGANIZATION_MEMBERS_READ_SCOPE } from "./scopes";
import {
  actingView,
  adminMemberView,
  adminOrganizationView,
  invitationOfferView,
  invitationView,
  MARKS_SEGMENT,
  membershipView,
  memberView,
  nominationView,
  organizationView,
} from "./views";

/**
 * The tenancy route surface: what each route accepts, and what proves the caller may call it.
 *
 * | Route                                          | Verification   | Power                 | Input                          |
 * | ---------------------------------------------- | -------------- | --------------------- | ------------------------------ |
 * | `GET    {base}`                                | session        | —                     | none                           |
 * | `POST   {base}`                                | session        | — (see self-service)  | json `CreateOrganization`      |
 * | `POST   {base}/acting`                         | session        | —                     | json `ChooseOrganization`      |
 * | `GET    {base}/current`                        | session        | `organization:read`   | none                           |
 * | `PATCH  {base}/current`                        | session        | `organization:manage` | json `UpdateOrganization`      |
 * | `DELETE {base}/current`                        | session        | `organization:delete` | none                           |
 * | `GET    {base}/current/members`                | session        | `organization:read`   | none                           |
 * | `PATCH  {base}/current/members/:membershipId`  | session        | `organization:manage` | param + json `ChangeRole`      |
 * | `DELETE {base}/current/members/:membershipId`  | session        | `organization:manage` | param `MembershipParam`        |
 * | `POST   {base}/current/members/leave`          | session        | —                     | none                           |
 * | `GET    {base}/current/invitations`            | session        | `organization:manage` | none                           |
 * | `POST   {base}/current/invitations`            | session        | `organization:manage` | json `InviteMember`            |
 * | `DELETE {base}/current/invitations/:id`        | session        | `organization:manage` | param `InvitationParam`        |
 * | `GET    {base}/invitations/:token`             | public         | —                     | param `InvitationTokenParam`   |
 * | `POST   {base}/invitations/accept`             | session        | —                     | json `AcceptInvitation`        |
 * | `POST   {base}/current/ownership`              | session        | `billing:manage`      | json `NominateOwner`           |
 * | `DELETE {base}/current/ownership`              | session        | holder, or unheld     | none                           |
 * | `POST   {base}/ownership/accept`               | session        | —                     | none                           |
 * | `GET    {base}/marks/organization/:id`         | session        | — (membership)        | param `OrganizationMarkParam`  |
 * | `GET    {base}/members/:membershipId/image`    | session        | `organization:read`   | param `MemberMarkParam`        |
 * | `GET    {base}/admin/organizations`            | control-plane  | scope                 | query `AdminListQuery`         |
 * | `GET    {base}/admin/organizations/:id/members`| control-plane  | scope                 | param + query                  |
 *
 * ## Three routes name an organization, and every other one is the session's
 *
 * The acting organization is session state — `../data/actingOrganization.ts` argues why at length — so a
 * scoped route has no field and no path segment that could carry another tenant's id. `POST {base}/acting`
 * is where a caller names one, and it is the single write that turns a supplied id into a membership.
 * The mark route names one because the chooser draws marks before anything is in force. The admin
 * roster route names one because a management credential holds no membership to be in force at all.
 *
 * ## `requireSameOrigin()` is the **first** middleware on every mutating route, not the last
 *
 * Every other gate here is about the caller; this one is about where the request came from, and it is
 * the cheapest and least revealing of the three. Running it first means a cross-origin post is refused
 * before a query runs and before a validator reports which bodies are well-formed — and it gives
 * `routeContract.test.ts` a discriminator no middleware count could be: with no capability publishing an
 * origin policy the gate denies with `auth/forbidden`, so a mutating route that lost its CSRF guard
 * answers `core/unauthorized` instead and the suite fails. A rule that can only be checked by reading
 * the file is a rule that stops holding on the day somebody adds a route in a hurry.
 *
 * ## Validators sit after the gates, except where a gate reads one
 *
 * A validator ahead of a gate turns a 403 into a 400 and tells a caller who has proved nothing which
 * requests were well-formed. The exception is the two routes that **name** an organization or a
 * membership: `requireOrganization(deps, named)` reads the id back through `c.req.valid(...)`, so the
 * schema has to be declared above it. Nothing is lost — the only thing a caller learns there is whether
 * their id was a UUID, which they wrote.
 *
 * ## The ownership routes mount only when the transfer's roles are wired
 *
 * A transfer moves a pair — the role somebody takes, and the role the previous holder falls back to —
 * and `../ownership/ownership.ts` refuses to run one whose conferred role is assignable. A catalog that
 * excludes nothing has no such pair, and for it the two-party transfer is not a feature that is broken
 * but a feature that does not exist. Mounting routes that could only ever refuse would be worse than not
 * mounting them, so {@link OrganizationRoutesOptions.ownership} decides, and the route contract pins
 * both surfaces.
 */

/** One route this capability mounts, and everything that has to be true about it. */
export interface OrganizationRouteDeclaration {
  readonly method: "GET" | "POST" | "PATCH" | "DELETE";
  /** The path relative to the configured `basePath`. Empty string is the base itself. */
  readonly path: string;
  readonly strategy: VerificationStrategy;
  /** The kit power the route demands, for a route gated by one. */
  readonly power?: KitPower;
  /** The control-plane scope, for a `control-plane` route. */
  readonly scope?: ControlPlaneScope;
  /** Whether the route changes something, and therefore wears `requireSameOrigin()`. */
  readonly mutating: boolean;
  /** Whether the route exists only where {@link OrganizationRoutesOptions.ownership} is wired. */
  readonly ownership?: true;
}

/**
 * Every route, and how it is gated.
 *
 * **A declaration rather than an inference, so it can drift from the router** — and `routeContract.test.ts`
 * is what stops it, checking this list against what Hono actually mounted in both directions. A route
 * added without an entry and an entry naming a route nobody mounts both fail there, which is what makes
 * this table the one record of a route's verification strategy rather than a comment about one.
 */
export const ORGANIZATION_ROUTES: readonly OrganizationRouteDeclaration[] = [
  { method: "GET", path: "", strategy: "session", mutating: false },
  { method: "POST", path: "", strategy: "session", mutating: true },
  { method: "POST", path: "/acting", strategy: "session", mutating: true },
  { method: "GET", path: "/current", strategy: "session", power: "organization:read", mutating: false },
  { method: "PATCH", path: "/current", strategy: "session", power: "organization:manage", mutating: true },
  { method: "DELETE", path: "/current", strategy: "session", power: "organization:delete", mutating: true },
  { method: "GET", path: "/current/members", strategy: "session", power: "organization:read", mutating: false },
  {
    method: "PATCH",
    path: "/current/members/:membershipId",
    strategy: "session",
    power: "organization:manage",
    mutating: true,
  },
  {
    method: "DELETE",
    path: "/current/members/:membershipId",
    strategy: "session",
    power: "organization:manage",
    mutating: true,
  },
  { method: "POST", path: "/current/members/leave", strategy: "session", mutating: true },
  { method: "GET", path: "/current/invitations", strategy: "session", power: "organization:manage", mutating: false },
  { method: "POST", path: "/current/invitations", strategy: "session", power: "organization:manage", mutating: true },
  {
    method: "DELETE",
    path: "/current/invitations/:invitationId",
    strategy: "session",
    power: "organization:manage",
    mutating: true,
  },
  // A resend revives an offer of a role, so it spends `requireMayAssign` again — on the role the stored
  // row holds, never the request's.
  {
    method: "POST",
    path: "/current/invitations/:invitationId/resend",
    strategy: "session",
    power: "organization:manage",
    mutating: true,
  },
  // Public, and it grants nothing. The link in the mail resolves here; acceptance is the POST below.
  { method: "GET", path: "/invitations/:token", strategy: "public", mutating: false },
  { method: "POST", path: "/invitations/accept", strategy: "session", mutating: true },
  /*
    **None of the three names a power, and that is the correction rather than an omission.**

    The obvious gate — `billing:manage` on the two mutations — closes the account permanently in the
    catalog this kit scaffolds: the conferred role holds that power and nothing else does, and a founded
    account has no holder of it. So "anybody in the account may volunteer" became "the owner the account
    does not have", and since the conferred role is unassignable there was no route that could repair it.

    What replaces it is the rule `ownership.ts` already held, which is conditional in a way a power
    cannot be: while somebody holds the account only they hand it on or take an offer back, and while
    nobody does, anybody in it may volunteer themselves and appoint nobody else. On a held account that
    is *stronger* than the power it replaced, because it names the holder rather than a power the holder
    happens to have.

    The read is membership alone for a different reason: the nominee is by definition the person who does
    not hold the account yet, so any power gate would hide the offer from the one caller it exists for.
  */
  { method: "GET", path: "/current/ownership", strategy: "session", mutating: false, ownership: true },
  { method: "POST", path: "/current/ownership", strategy: "session", mutating: true, ownership: true },
  { method: "DELETE", path: "/current/ownership", strategy: "session", mutating: true, ownership: true },
  { method: "POST", path: "/ownership/accept", strategy: "session", mutating: true, ownership: true },
  { method: "GET", path: `${MARKS_SEGMENT}/organization/:organizationId`, strategy: "session", mutating: false },
  {
    method: "GET",
    path: `${MEMBERS_PATH_SEGMENT}/:membershipId/image`,
    strategy: "session",
    power: "organization:read",
    mutating: false,
  },
  {
    method: "GET",
    path: "/admin/organizations",
    strategy: "control-plane",
    scope: ORGANIZATION_ACCOUNTS_READ_SCOPE,
    mutating: false,
  },
  {
    method: "GET",
    path: "/admin/organizations/:organizationId/members",
    strategy: "control-plane",
    scope: ORGANIZATION_MEMBERS_READ_SCOPE,
    mutating: false,
  },
];

/** Milliseconds in a day, for the one arithmetic this module does. */
const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * How many organization ids one statement resolves at a time.
 *
 * D1 binds a bounded number of parameters, and the chooser's second read is `where id in (…)` over
 * whatever the membership join returned. Chunked rather than capped: somebody in two hundred accounts
 * gets four statements and a complete list, where a cap would hand them a short one presented as whole.
 */
const ID_LOOKUP_CHUNK = 50;

/** What `registerOrganizationRoutes` takes. */
export interface OrganizationRoutesOptions<Power extends string, Role extends string> {
  /** The project's declared catalog. Every authorization question here is asked of it. */
  readonly catalog: RoleCatalog<Power, Role>;
  /** The resolved configuration. */
  readonly config: OrganizationConfig;
  /** Where the routes mount. Defaults to the config's own `basePath`. */
  readonly basePath?: string;
  /** The name of the D1 binding the tenancy tables live in. Defaults to `DB`. */
  readonly databaseBinding?: string;
  /**
   * The two roles a transfer of ownership moves — read from **one** place and handed to both ends.
   *
   * Absent means this project has no two-party transfer, and the three ownership routes do not mount.
   * The type system cannot stop a caller passing one pair to the offer and another to the acceptance;
   * reading the constant from here is what does.
   */
  readonly ownership?: OwnershipRoles<Role>;
  /**
   * The email enqueue seam.
   *
   * Takes the request env rather than being pre-bound, because a Worker's `env` is per-request: a seam
   * captured at registration would close over whichever request happened to assemble the routes.
   */
  readonly enqueue?: (env: Record<string, unknown>) => EnqueueInvitation | undefined;
  /** The clock. Injected so expiries and stored timestamps are deterministic in tests. */
  readonly now?: () => Date;
  /** The id source. Injected for the same reason. */
  readonly newId?: () => string;
}

/**
 * Require an authenticated caller.
 *
 * **Copied rather than imported from `@pithy-sh/auth`**, matching every other capability in the repo: a
 * package that borrows its authorization fails *open* when the lender is absent. With the guard local, a
 * project that never composed auth leaves `c.var.auth` null and every gated route denies — the only
 * acceptable direction for that failure to go. `requireOrganization()` performs the same check for
 * itself; this is for the four routes that have no organization to resolve.
 */
function requireAuth<Role extends string>(): MiddlewareHandler<OrganizationHonoEnv<Role>> {
  return async (c, next) => {
    if (!c.var.auth) {
      throw new UnauthorizedError({
        message: "Sign in to continue.",
        action: "Retry with a valid session or bearer token.",
        detail: "an organization route ran with no resolved session",
      });
    }
    await next();
  };
}

/**
 * Register the tenancy routes onto the backend's Hono app.
 *
 * **The cast at the top is the single seam a capability adding a context variable has to spend.** Hono's
 * `Context` is invariant in its env, so routes that read `c.var.acting` cannot be typed against the base
 * `PithyHonoEnv` the `routes` hook hands over. One cast here, at assembly, rather than one per handler:
 * the variable is set by `requireOrganization()` and by nothing else, so what makes it true is the gate
 * on the route line and not the type.
 */
export function registerOrganizationRoutes<Power extends string, Role extends string>(
  options: OrganizationRoutesOptions<Power, Role>,
): (app: Hono<PithyHonoEnv>) => void {
  const { catalog, config } = options;
  const base = options.basePath ?? config.basePath;
  const binding = options.databaseBinding ?? "DB";
  const clock = options.now ?? (() => new Date());
  const ids = options.newId ?? (() => crypto.randomUUID());

  type Env = OrganizationHonoEnv<Role>;
  type Ctx = Context<Env>;

  /** The D1 binding this invocation was given, or a stated wiring failure rather than a silent undefined. */
  function d1(c: Ctx): D1Database {
    const found = (c.env as Record<string, unknown>)[binding];
    if (!found) {
      throw new InternalError({
        message: "The organization database is not configured.",
        action: `Bind a D1 database named ${binding} in wrangler.jsonc, then run pithy migrate.`,
        detail: `the organization routes require a "${binding}" D1 binding; none was present on env`,
      });
    }
    return found as D1Database;
  }

  const db = (c: Ctx): OrganizationDatabase => organizationDatabase(d1(c));
  const auth = (c: Ctx): AuthDatabase => authDatabase(d1(c));

  const deps: OrganizationGuardDeps<Power, Role> = {
    catalog,
    database: (env) => {
      const found = env[binding];
      if (!found) {
        throw new InternalError({
          message: "The organization database is not configured.",
          action: `Bind a D1 database named ${binding} in wrangler.jsonc, then run pithy migrate.`,
          detail: `the organization gates require a "${binding}" D1 binding; none was present on env`,
        });
      }
      return organizationDatabase(found as D1Database);
    },
  };

  // The published CSRF gate, read back rather than rebuilt. It arrives already bound to the origins the
  // composing capability resolved, so there is no origin list to pass and therefore no wrong one. The
  // cast is the invariance seam the function docblock names, spent once.
  const csrf = requireSameOrigin() as unknown as MiddlewareHandler<Env>;
  const gate = (scope: ControlPlaneScope): MiddlewareHandler<Env> =>
    requireControlPlane(scope) as unknown as MiddlewareHandler<Env>;

  /** The signed-in caller. Every route calling this has a gate above it, so a null here is a wiring fault. */
  function session(c: Ctx): { userId: string; sessionId: string } {
    const resolved = c.var.auth;
    if (!resolved) {
      throw new InternalError({ detail: "requireAuth() must run before an organization handler reads the caller." });
    }
    return { userId: resolved.userId, sessionId: resolved.sessionId };
  }

  /** Record one administrative act, with this request's correlation and the session that took it. */
  async function record(c: Ctx, event: Omit<OrganizationAuditEvent, "ip" | "userAgent" | "sessionId">): Promise<void> {
    await recordOrganizationAction(c.var.emit, {
      ...event,
      ...correlation(c.req.raw.headers),
      sessionId: c.var.auth?.sessionId ?? null,
    });
  }

  /** One organization row, or null. Nothing is decided here — the caller says what absence means. */
  async function findOrganization(database: OrganizationDatabase, id: string): Promise<Organization | null> {
    const row = await database.selectFrom(ORGANIZATIONS_TABLE).selectAll().where("id", "=", id).executeTakeFirst();
    return row ? Organization.parse(row) : null;
  }

  /**
   * The organization a gate already proved a membership in.
   *
   * Absence here is a row deleted between the gate and this read, and it answers the same 404 as every
   * other absence in the capability — because a caller must not be able to tell a race apart from an
   * account that was never theirs.
   */
  async function readOrganization(database: OrganizationDatabase, id: string): Promise<Organization> {
    const found = await findOrganization(database, id);
    if (!found) throw noSuchOrganization(`organization ${id} was gone by the time a proved membership read it`);
    return found;
  }

  /** Organization rows by id, chunked to stay inside D1's bound-parameter budget. */
  async function readOrganizations(
    database: OrganizationDatabase,
    organizationIds: readonly string[],
  ): Promise<Map<string, Organization>> {
    const found = new Map<string, Organization>();
    for (let at = 0; at < organizationIds.length; at += ID_LOOKUP_CHUNK) {
      const chunk = organizationIds.slice(at, at + ID_LOOKUP_CHUNK);
      if (chunk.length === 0) continue;
      const rows = await database.selectFrom(ORGANIZATIONS_TABLE).selectAll().where("id", "in", chunk).execute();
      for (const row of rows) {
        const organization = Organization.parse(row);
        found.set(organization.id, organization);
      }
    }
    return found;
  }

  /**
   * How many rows one organization holds in a table.
   *
   * A count rather than the length of a list, because the record pane wants a number and reading a
   * five-hundred-person roster to report `500` is a page of bytes spent on one integer.
   */
  async function countRows(
    database: OrganizationDatabase,
    table: typeof MEMBERSHIPS_TABLE | typeof INVITATIONS_TABLE,
    organizationId: string,
    pendingOnly = false,
  ): Promise<number> {
    let query = database
      .selectFrom(table)
      .select((eb) => eb.fn.countAll<number>().as("total"))
      .where("organizationId", "=", organizationId);
    if (pendingOnly) query = query.where("status", "=", "pending");
    const row = await query.executeTakeFirstOrThrow();
    return Number(row.total);
  }

  /** Serve stored bytes, or 404 — which is also the answer for a vector, and that is the whole gate. */
  function serveMark(stored: string | null, why: string): Response {
    const bytes = storedImageBytes(stored);
    if (!bytes) {
      // One answer for three facts — nothing stored, a vector, a value the allowlist does not match. The
      // caller has already been proved entitled to look, so none of them is a secret; they are one answer
      // because the route has exactly one thing to say, which is *nothing to serve here*.
      throw new NotFoundError({ message: "No mark to show.", detail: why });
    }
    return new Response(bytes.body as unknown as BodyInit, {
      headers: { "content-type": bytes.type, ...STORED_IMAGE_HEADERS },
    });
  }

  /** The one refusal an unredeemable link gets, in every one of its forms. */
  function offerInvalid(why: string): OrganizationInvitationInvalidError {
    return new OrganizationInvitationInvalidError({ detail: why });
  }

  return (backend) => {
    const app = backend as unknown as Hono<Env>;

    // ── the chooser's two routes: what the caller may act in, and what they act in ──────────────

    app.get(base, requireAuth<Role>(), async (c) => {
      const who = session(c);
      const database = db(c);
      // The membership join is the entitlement; the second read is only the rows it named. An
      // organization list built the other way round would be every tenant in the database, filtered.
      const actable = await listActable(database, catalog, who.userId);
      const acting = await resolveActing(database, catalog, who);
      const rows = await readOrganizations(
        database,
        actable.map((membership) => membership.organizationId),
      );
      return c.json({
        organizations: actable.flatMap((membership) => {
          const organization = rows.get(membership.organizationId);
          return organization ? [organizationView(organization, membership.role, base)] : [];
        }),
        acting: acting?.organizationId ?? null,
        chosen: acting?.chosen ?? false,
      } satisfies OrganizationsResponse);
    });

    /**
     * Found an organization.
     *
     * **Refused for everybody when `allowSelfService` is false**, rather than gated on a power nobody
     * holds. There is no organization in force yet and therefore no role to read, so the only honest
     * shape of that setting is a route that says no to every caller — including the operator, who
     * provisions through their own code with an actor they can name.
     *
     * It does **not** move the acting selection. Creating a second account from a settings pane must not
     * silently move somebody out of the one they were working in; the client chooses the new account with
     * `POST {base}/acting` when that is what the person meant.
     */
    app.post(base, csrf, requireAuth<Role>(), zValidator("json", CreateOrganization, validationHook), async (c) => {
      if (!config.allowSelfService) {
        throw new OrganizationForbiddenError({
          message: "Organizations are created by the operator here.",
          action: "Ask for one to be created.",
          detail: "allowSelfService is false, so this route refuses every caller",
        });
      }
      const who = session(c);
      const body = c.req.valid("json");
      const created = await createOrganization(d1(c), catalog, {
        name: body.name,
        slug: body.slug,
        founderUserId: who.userId,
        now: clock(),
        newId: ids,
      });
      await record(c, {
        action: OrganizationAuditActions.created,
        actor: { organizationId: created.organization.id, userId: who.userId },
        resource: { type: "organization", id: created.organization.id },
        facts: { slug: created.organization.slug, role: created.membership.role },
      });
      return c.json(
        {
          organization: organizationView(created.organization, created.membership.role, base),
        } satisfies OrganizationResponse,
        201,
      );
    });

    /**
     * Choose the organization this session acts in.
     *
     * The membership is proved inside `chooseActing`, in the predicate that names both halves, and an
     * account the caller is not in refuses with the same 404 as one that does not exist. The answer is
     * read back off the row the write left rather than echoed from the request — a client re-rendering
     * from what it sent is rendering what it asked for, and the two differ exactly when something refused.
     */
    app.post(
      `${base}/acting`,
      csrf,
      requireAuth<Role>(),
      zValidator("json", ChooseOrganization, validationHook),
      async (c) => {
        const who = session(c);
        const database = db(c);
        await chooseActing(database, { ...who, organizationId: c.req.valid("json").organizationId, now: clock() });
        const acting = await resolveActing(database, catalog, who);
        if (!acting) {
          // The membership went between the proof and the read. Same 404 as every other absence.
          throw noSuchOrganization(
            `selection for user ${who.userId} resolved to no membership immediately after it was written`,
          );
        }
        return c.json(actingView(acting));
      },
    );

    // ── the account in force ───────────────────────────────────────────────────────────────────

    app.get(
      `${base}/current`,
      requireOrganization(deps),
      requirePower<Power, Role>("organization:read", deps),
      async (c) => {
        const acting = c.var.acting;
        const database = db(c);
        const organization = await readOrganization(database, acting.organizationId);
        // Null rather than zero for somebody who cannot manage the account: who has been asked and has
        // not answered is of no use to a reader who can neither withdraw an offer nor resend one, and a
        // zero would be this record answering a question it declined to read.
        const mayManage = catalog.roleAllows(acting.role, "organization:manage");
        return c.json({
          organization: organizationView(organization, acting.role, base),
          totals: {
            members: await countRows(database, MEMBERSHIPS_TABLE, acting.organizationId),
            invitations: mayManage ? await countRows(database, INVITATIONS_TABLE, acting.organizationId, true) : null,
          },
        } satisfies OrganizationRecordResponse);
      },
    );

    /**
     * Rename the account, set its mark, or take the mark off.
     *
     * Two writers rather than one, because absent and `null` are different instructions and a single
     * `set` built by spreading the body would collapse them — writing `logo = NULL` for a rename that
     * never mentioned it. They are audited separately for the same reason: folding a mark change into a
     * rename would put a lie in an append-only table.
     */
    app.patch(
      `${base}/current`,
      csrf,
      requireOrganization(deps),
      requirePower<Power, Role>("organization:manage", deps),
      zValidator("json", UpdateOrganization, validationHook),
      async (c) => {
        const acting = c.var.acting;
        const who = session(c);
        const body = c.req.valid("json");
        const now = clock();
        const actor = { organizationId: acting.organizationId, userId: who.userId };
        const resource = { type: "organization", id: acting.organizationId } as const;

        if (body.name !== undefined) {
          await renameOrganization(d1(c), { organizationId: acting.organizationId, name: body.name, now });
          // The new name, never the old one — a trail that kept both would be a history of what every
          // tenant used to call itself, held forever for a question nobody asks.
          await record(c, { action: OrganizationAuditActions.renamed, actor, resource, facts: { name: body.name } });
        }
        if (body.logo !== undefined) {
          await setLogo(d1(c), { organizationId: acting.organizationId, logo: body.logo, now });
          // Whether there is one now, never the bytes.
          await record(c, {
            action: OrganizationAuditActions.logoChanged,
            actor,
            resource,
            facts: { cleared: body.logo === null },
          });
        }
        const organization = await readOrganization(db(c), acting.organizationId);
        return c.json({
          organization: organizationView(organization, acting.role, base),
        } satisfies OrganizationResponse);
      },
    );

    app.delete(
      `${base}/current`,
      csrf,
      requireOrganization(deps),
      requirePower<Power, Role>("organization:delete", deps),
      async (c) => {
        const acting = c.var.acting;
        const who = session(c);
        await deleteOrganization(d1(c), acting.organizationId);
        // Recorded against the account that no longer exists, which is the only record that it ever did.
        await record(c, {
          action: OrganizationAuditActions.deleted,
          actor: { organizationId: acting.organizationId, userId: who.userId },
          resource: { type: "organization", id: acting.organizationId },
          severity: "warning",
        });
        return c.json({ organizationId: acting.organizationId } satisfies DeletedOrganizationResponse);
      },
    );

    // ── the roster ─────────────────────────────────────────────────────────────────────────────

    app.get(
      `${base}/current/members`,
      requireOrganization(deps),
      requirePower<Power, Role>("organization:read", deps),
      async (c) => {
        const acting = c.var.acting;
        const memberships = await listMembers(db(c), acting.organizationId);
        // Through the auth capability's own published reader, never a join written here —
        // `pithy_auth_accounts` sits beside that table holding live provider credentials.
        const people = await readPeople(
          auth(c),
          memberships.map((membership) => membership.userId),
        );
        return c.json({
          members: memberships.map((membership) => memberView(membership, people.get(membership.userId), base)),
        } satisfies MembersResponse);
      },
    );

    app.patch(
      `${base}/current/members/:membershipId`,
      csrf,
      requireOrganization(deps),
      requirePower<Power, Role>("organization:manage", deps),
      zValidator("param", MembershipParam, validationHook),
      zValidator("json", ChangeRole, validationHook),
      async (c) => {
        const acting = c.var.acting;
        const who = session(c);
        // `changeRole` spends `requireMayAssign` itself, which is what makes the rule one function both
        // this door and the invitation below call rather than two copies that can disagree.
        const changed = await changeRole(db(c), catalog, {
          organizationId: acting.organizationId,
          membershipId: c.req.valid("param").membershipId,
          role: c.req.valid("json").role,
          actor: acting,
        });
        await record(c, {
          action: OrganizationAuditActions.memberRoleChanged,
          actor: { organizationId: acting.organizationId, userId: who.userId },
          resource: { type: "membership", id: changed.id },
          facts: { role: changed.role, subjectUserId: changed.userId },
        });
        return c.json({ member: membershipView(changed) } satisfies MemberRoleResponse);
      },
    );

    app.delete(
      `${base}/current/members/:membershipId`,
      csrf,
      requireOrganization(deps),
      requirePower<Power, Role>("organization:manage", deps),
      zValidator("param", MembershipParam, validationHook),
      async (c) => {
        const acting = c.var.acting;
        const who = session(c);
        const removed = await removeMember(d1(c), catalog, {
          organizationId: acting.organizationId,
          membershipId: c.req.valid("param").membershipId,
          actor: acting,
        });
        await record(c, {
          // Two codes, because a removal and a leaving are two events with two subjects. Naming a member
          // removed when they walked out is a sentence somebody reads a fortnight later and believes.
          action: removed.left ? OrganizationAuditActions.memberLeft : OrganizationAuditActions.memberRemoved,
          actor: { organizationId: acting.organizationId, userId: who.userId },
          resource: { type: "membership", id: removed.membership.id },
          facts: { role: removed.membership.role, subjectUserId: removed.membership.userId },
        });
        return c.json({
          membershipId: removed.membership.id,
          left: removed.left,
        } satisfies RemovedMemberResponse);
      },
    );

    /**
     * Leave the organization in force.
     *
     * **No power, and no membership id.** You leave an account; you do not name a row. The floor still
     * applies — walking out as the last administrator leaves exactly the account nobody can repair that
     * the invariant exists to prevent — and so does the unassignable-role rule, so the holder of a role
     * that arrived by transfer has no exit that is not another transfer.
     */
    app.post(`${base}/current/members/leave`, csrf, requireOrganization(deps), async (c) => {
      const acting = c.var.acting;
      const who = session(c);
      const removed = await leaveOrganization(d1(c), catalog, {
        organizationId: acting.organizationId,
        actor: acting,
      });
      await record(c, {
        action: OrganizationAuditActions.memberLeft,
        actor: { organizationId: acting.organizationId, userId: who.userId },
        resource: { type: "membership", id: removed.membership.id },
        facts: { role: removed.membership.role },
      });
      return c.json({ membershipId: removed.membership.id, left: true } satisfies RemovedMemberResponse);
    });

    // ── invitations ────────────────────────────────────────────────────────────────────────────

    app.get(
      `${base}/current/invitations`,
      requireOrganization(deps),
      requirePower<Power, Role>("organization:manage", deps),
      async (c) => {
        const invitations = await listInvitations(db(c), c.var.acting.organizationId);
        return c.json({ invitations: invitations.map(invitationView) } satisfies InvitationsResponse);
      },
    );

    /**
     * Offer membership to an address.
     *
     * **Both gates are spent before a row is written, and one of them is not the route's own.**
     * `organization:manage` runs the roster; handing somebody a role that *administers* additionally
     * takes `members:manage`, and that is `requireMayAssign` from `../members/members.ts` — the same
     * function `changeRole` calls, because an invitation offering an administering role is a promotion
     * arriving by the other door. A rule checked in one of the two is a rule with a second door.
     *
     * **The mail seam and the origin are resolved before the offer is minted.** An invitation written and
     * then not sent is a live token nobody receives and nobody can withdraw from a list they never saw.
     */
    app.post(
      `${base}/current/invitations`,
      csrf,
      requireOrganization(deps),
      requirePower<Power, Role>("organization:manage", deps),
      zValidator("json", InviteMember, validationHook),
      async (c) => {
        const acting = c.var.acting;
        const who = session(c);
        const body = c.req.valid("json");
        const database = db(c);
        const now = clock();

        // Only when the catalog knows the name. An unknown or excluded role is `invite()`'s refusal to
        // make — it owns the assignable set — and `requireMayAssign` takes a declared role.
        const assigned = catalog.AssignableRole.safeParse(body.role);
        if (assigned.success) requireMayAssign(catalog, acting.role, assigned.data as Role);

        const enqueue = config.sendInvitationEmail ? options.enqueue?.(c.env as Record<string, unknown>) : undefined;
        if (config.sendInvitationEmail && !enqueue) {
          throw new InternalError({
            message: "That invitation could not be sent.",
            action: "Add `email(...)` to this Worker's capabilities, or set `sendInvitationEmail: false`.",
            detail: "sendInvitationEmail is true and no email capability published an enqueue seam",
          });
        }
        // Proves the origin is configured **before** a row is written. The value is thrown away; what is
        // wanted is the refusal `invitationAcceptUrl` raises when `baseUrl` is unset, raised at the moment
        // nothing has been minted yet rather than one statement later with an unsendable offer on disk.
        invitationAcceptUrl(config, "preflight");

        const minted = await invite(database, catalog, {
          organizationId: acting.organizationId,
          email: body.email,
          role: body.role as Role,
          invitedByUserId: who.userId,
          ttlDays: config.invitationTtlDays,
          now,
          newId: ids,
        });
        const acceptUrl = invitationAcceptUrl(config, minted.token);

        let sent: string | null = null;
        if (enqueue) {
          const organization = await readOrganization(database, acting.organizationId);
          const inviter = (await readPeople(auth(c), [who.userId])).get(who.userId);
          const result = await sendInvitationMail(enqueue, {
            to: minted.invitation.email,
            organizationName: organization.name,
            inviterName: inviter?.name?.trim() || "Somebody",
            acceptUrl,
          });
          sent = result.status;
        }

        // The role and the offer's id. **Never the address and never the token** — the trail is
        // append-only and nobody prunes it, which is the opposite rule from the roster beside it.
        await record(c, {
          action: OrganizationAuditActions.memberInvited,
          actor: { organizationId: acting.organizationId, userId: who.userId },
          resource: { type: "invitation", id: minted.invitation.id },
          facts: { role: minted.invitation.role, mailed: sent },
        });

        return c.json(
          {
            invitation: invitationView(minted.invitation),
            // The link leaves the Worker only where nobody else is going to send it. When the capability
            // mailed it, the token is in the mail and in no response body, which is the whole point of
            // putting it there.
            acceptUrl: enqueue ? null : acceptUrl,
          } satisfies InviteResponse,
          201,
        );
      },
    );

    /**
     * Send an invitation again.
     *
     * **`requireMayAssign` is spent a second time here, and that is not belt-and-braces.** A resend
     * revives an offer of a role, so it is the same act as making it: a member promoted to administrator
     * between the first send and the resend must not be able to re-offer an administering role they
     * could no longer grant. The role is read off the stored row rather than off the request, so what is
     * re-offered is what was offered.
     *
     * The old link stops working in the same write — one live token per offer — which is why this is a
     * mutation rather than a second GET of the same thing.
     */
    app.post(
      `${base}/current/invitations/:invitationId/resend`,
      csrf,
      requireOrganization(deps),
      requirePower<Power, Role>("organization:manage", deps),
      zValidator("param", InvitationParam, validationHook),
      async (c) => {
        const acting = c.var.acting;
        const who = session(c);
        const database = db(c);

        const enqueue = config.sendInvitationEmail ? options.enqueue?.(c.env as Record<string, unknown>) : undefined;
        if (config.sendInvitationEmail && !enqueue) {
          throw new InternalError({
            message: "That invitation could not be sent.",
            action: "Add `email(...)` to this Worker's capabilities, or set `sendInvitationEmail: false`.",
            detail: "sendInvitationEmail is true and no email capability published an enqueue seam",
          });
        }
        // Before anything is written, as on the send path and for the same reason.
        invitationAcceptUrl(config, "preflight");

        const existing = await requireInvitationInOrganization(
          database,
          acting.organizationId,
          c.req.valid("param").invitationId,
        );
        /*
          Off the row, never the request. The standing to re-offer is checked against what the offer
          says, so a caller cannot widen it by resending.

          **And a role the catalog no longer assigns is refused outright rather than waved through.** The
          same `if (success)` shape on the send route above is safe because `invite()` refuses an
          unassignable role itself; `resendInvitation` inspects no role at all, so here the conditional
          would be the only guard — and it would be skipped precisely where the rule is strictest. A
          pending offer of a role the project has since reserved is dead, not renewable, and the refusal
          is the ordinary one so a caller learns nothing about the catalog from it.
        */
        const offered = catalog.AssignableRole.safeParse(existing.role);
        if (!offered.success) {
          throw offerInvalid(
            `invitation ${existing.id} offers role ${JSON.stringify(existing.role)}, which this catalog no longer assigns`,
          );
        }
        requireMayAssign(catalog, acting.role, offered.data as Role);

        const minted = await resendInvitation(database, {
          organizationId: acting.organizationId,
          invitationId: existing.id,
          ttlDays: config.invitationTtlDays,
          now: clock(),
        });
        const acceptUrl = invitationAcceptUrl(config, minted.token);

        let sent: string | null = null;
        if (enqueue) {
          const organization = await readOrganization(database, acting.organizationId);
          const inviter = (await readPeople(auth(c), [who.userId])).get(who.userId);
          const result = await sendInvitationMail(enqueue, {
            to: minted.invitation.email,
            organizationName: organization.name,
            inviterName: inviter?.name?.trim() || "Somebody",
            acceptUrl,
          });
          sent = result.status;
        }

        await record(c, {
          action: OrganizationAuditActions.invitationResent,
          actor: { organizationId: acting.organizationId, userId: who.userId },
          resource: { type: "invitation", id: minted.invitation.id },
          facts: { role: minted.invitation.role, mailed: sent },
        });

        return c.json({
          invitation: invitationView(minted.invitation),
          acceptUrl: enqueue ? null : acceptUrl,
        } satisfies InviteResponse);
      },
    );

    app.delete(
      `${base}/current/invitations/:invitationId`,
      csrf,
      requireOrganization(deps),
      requirePower<Power, Role>("organization:manage", deps),
      zValidator("param", InvitationParam, validationHook),
      async (c) => {
        const acting = c.var.acting;
        const who = session(c);
        const invitation = await withdrawInvitation(db(c), {
          organizationId: acting.organizationId,
          invitationId: c.req.valid("param").invitationId,
          now: clock(),
        });
        await record(c, {
          action: OrganizationAuditActions.invitationRevoked,
          actor: { organizationId: acting.organizationId, userId: who.userId },
          resource: { type: "invitation", id: invitation.id },
          facts: { role: invitation.role },
        });
        return c.json({ invitation: invitationView(invitation) } satisfies WithdrawnInvitationResponse);
      },
    );

    /**
     * What an accept screen renders, for somebody holding a link and nothing else.
     *
     * **Public, and it grants nothing.** `invitationAcceptUrl` mints `{base}/invitations/{token}` because
     * an email cannot post, so this is the URL in every invitation already sent — and a route that did
     * not exist would make that link a 404 for the one person it was written for. What it answers is the
     * three facts a person needs in order to decide; the membership is still written only by the POST
     * below, which carries the token where a referrer header cannot reach it.
     *
     * Every refusal is the same sentence — unknown token, spent, withdrawn, expired, an account since
     * deleted — because telling somebody which it was tells whoever a link was forwarded to the same
     * thing.
     */
    app.get(`${base}/invitations/:token`, zValidator("param", InvitationTokenParam, validationHook), async (c) => {
      const database = db(c);
      const now = clock();
      // Matched by digest, never by the token as it arrived: a read of that table must not yield
      // something that can be redeemed.
      const row = await database
        .selectFrom(INVITATIONS_TABLE)
        .selectAll()
        .where("tokenDigest", "=", await invitationDigest(c.req.valid("param").token))
        .executeTakeFirst();
      if (!row) throw offerInvalid("no invitation matches the presented token digest");
      const invitation = Invitation.parse(row);
      if (invitation.status !== "pending") throw offerInvalid(`invitation ${invitation.id} is ${invitation.status}`);
      if (invitation.expiresAt <= now) {
        throw offerInvalid(`invitation ${invitation.id} expired at ${invitation.expiresAt.toISOString()}`);
      }
      const organization = await findOrganization(database, invitation.organizationId);
      if (!organization) {
        throw offerInvalid(`organization ${invitation.organizationId} no longer exists`);
      }
      const inviter = (await readPeople(auth(c), [invitation.invitedByUserId])).get(invitation.invitedByUserId);
      return c.json(invitationOfferView(invitation, organization.name, inviter));
    });

    /**
     * Redeem an offer.
     *
     * **No `requireOrganization()`, deliberately.** The caller is not in the account yet — that is what
     * they are here to change — so a gate proving a membership would refuse every legitimate use.
     *
     * The authorization is the address: the accepting session's own, compared against the invited one.
     * It is read from `pithy_auth_users` rather than taken from the request, because a body that named
     * the address it was being matched against would be the caller answering their own question.
     */
    app.post(
      `${base}/invitations/accept`,
      csrf,
      requireAuth<Role>(),
      zValidator("json", AcceptInvitation, validationHook),
      async (c) => {
        const who = session(c);
        const me = (await readPeople(auth(c), [who.userId])).get(who.userId);
        if (!me) {
          // No address to compare, so nothing to authorize. The same sentence as every other refusal.
          throw offerInvalid(`no user row for ${who.userId}; an invitation is redeemed by address and there is none`);
        }
        const accepted = await acceptInvitation(d1(c), catalog, {
          token: c.req.valid("json").token,
          session: { userId: who.userId, email: me.email },
          now: clock(),
          newId: ids,
        });
        await record(c, {
          action: OrganizationAuditActions.memberJoined,
          actor: { organizationId: accepted.invitation.organizationId, userId: who.userId },
          resource: { type: "membership", id: accepted.membershipId },
          facts: { role: accepted.role, invitationId: accepted.invitation.id, joined: accepted.joined },
        });
        return c.json({
          organizationId: accepted.invitation.organizationId,
          membershipId: accepted.membershipId,
          role: accepted.role,
          joined: accepted.joined,
        } satisfies AcceptInvitationResponse);
      },
    );

    // ── ownership, where this project has a transfer at all ────────────────────────────────────

    const ownership = options.ownership;
    if (ownership) {
      /**
       * The account's one standing offer of ownership, or null.
       *
       * **Without this, nobody can discover through the API that they were nominated.** A nomination
       * carries no token and sends no mail — deliberately, because the nominee already holds a session
       * this account trusts — so the only way an offer reaches the person it was made to is a screen
       * that reads it. A transfer nobody can see is a transfer that never happens.
       *
       * Gated on membership alone rather than on `billing:manage`. The nominee is by definition the
       * person who does **not** hold the account yet, so a power gate here would hide the offer from
       * exactly the one caller it exists for. What it discloses is a fact about an organization the
       * caller has already been proved a member of: who was offered it, by whom, and until when.
       */
      app.get(`${base}/current/ownership`, requireOrganization(deps), async (c) => {
        const nomination = await standingNomination(db(c), c.var.acting.organizationId, clock());
        return c.json({
          nomination: nomination ? nominationView(nomination) : null,
        } satisfies NominationResponse);
      });

      app.post(
        `${base}/current/ownership`,
        csrf,
        requireOrganization(deps),
        zValidator("json", NominateOwner, validationHook),
        async (c) => {
          const acting = c.var.acting;
          const who = session(c);
          const now = clock();
          /*
            **Membership, and then the store's own rule — deliberately no `billing:manage` here.**

            The obvious gate is the wrong one, and it closes the account permanently. In the catalog this
            kit scaffolds, `billing:manage` is held by the conferred role and by nothing else, and a new
            account has no holder of it: `provision.ts` gives the founder the first *assignable*
            administering role, and the conferred role is unassignable by definition. So gating on
            `billing:manage` narrows "anybody in the account may volunteer" to "the owner the account
            does not have" — and since `changeRole` refuses the unassignable role too, nothing can ever
            repair it.

            `nominate` already holds the real rule, and it is conditional in a way a power cannot be:
            while somebody holds the account only they hand it on, and while nobody does anybody in it
            may volunteer themselves and appoint nobody else. That is stronger than `billing:manage`
            where an account is held, and it is the only thing that works where it is not.
          */
          const nomination = await nominate(db(c), catalog, {
            organizationId: acting.organizationId,
            membershipId: c.req.valid("json").membershipId,
            nominatedByUserId: who.userId,
            expiresAt: new Date(now.getTime() + config.nominationTtlDays * DAY_MS),
            roles: ownership,
            now,
          });
          await record(c, {
            action: OrganizationAuditActions.ownershipNominated,
            actor: { organizationId: acting.organizationId, userId: who.userId },
            resource: { type: "membership", id: nomination.membershipId },
            facts: { confers: ownership.confers },
          });
          return c.json({ nomination: nominationView(nomination) } satisfies NominationResponse, 201);
        },
      );

      app.delete(
        `${base}/current/ownership`,
        csrf,
        requireOrganization(deps),
        // Membership, and then the store's rule — the same correction the nominate route above carries,
        // for the same reason. A `billing:manage` gate here would stop an unheld account's volunteer
        // taking back their own offer, because nobody holds the power that would let them.
        async (c) => {
          const acting = c.var.acting;
          const who = session(c);
          const withdrawn = await withdrawNomination(db(c), {
            organizationId: acting.organizationId,
            userId: who.userId,
            roles: ownership,
          });
          // Only when there was one. Recording a withdrawal of nothing would put an act in the trail that
          // nobody took, and the answer to the caller is the same either way — there is no offer now.
          if (withdrawn) {
            await record(c, {
              action: OrganizationAuditActions.ownershipWithdrawn,
              actor: { organizationId: acting.organizationId, userId: who.userId },
              resource: { type: "organization", id: acting.organizationId },
            });
          }
          return c.json({ nomination: null } satisfies NominationResponse);
        },
      );

      /**
       * Accept the account.
       *
       * **No power.** Being the nominee is the entitlement, and `acceptNomination` proves it against the
       * standing offer — a caller holding every power in the catalog cannot accept an offer made to
       * somebody else, which is the whole of what makes the transfer two-party.
       */
      app.post(`${base}/ownership/accept`, csrf, requireOrganization(deps), async (c) => {
        const acting = c.var.acting;
        const who = session(c);
        const transfer = await acceptNomination(d1(c), catalog, {
          organizationId: acting.organizationId,
          userId: who.userId,
          now: clock(),
          roles: ownership,
        });
        await record(c, {
          action: OrganizationAuditActions.ownershipAccepted,
          actor: { organizationId: acting.organizationId, userId: who.userId },
          resource: { type: "membership", id: transfer.newHolderMembershipId },
          // It succeeded, and a reader scanning for what went quiet before an incident should find the
          // account changing hands above the routine.
          severity: "warning",
          facts: { confers: ownership.confers, demoted: transfer.previousHolderMembershipIds.length },
        });
        return c.json({
          newHolderMembershipId: transfer.newHolderMembershipId,
          previousHolderMembershipIds: [...transfer.previousHolderMembershipIds],
        } satisfies TransferResponse);
      });
    }

    // ── marks ─────────────────────────────────────────────────────────────────────────────────

    /**
     * An organization's mark.
     *
     * **Named in the path, and gated by membership in the organization it names** — not by the acting
     * selection, because this is drawn on the chooser, where nothing is in force yet and the caller may
     * belong to three accounts at once. The validator sits above the gate because the gate reads the id
     * back through `c.req.valid("param")`; nothing leaks, since the only thing a caller learns from the
     * 400 is whether what they typed was a UUID.
     */
    app.get(
      `${base}${MARKS_SEGMENT}/organization/:organizationId`,
      requireAuth<Role>(),
      zValidator("param", OrganizationMarkParam, validationHook),
      requireOrganization(deps, { from: "param", name: "organizationId" }),
      async (c) => {
        const organization = await readOrganization(db(c), c.var.acting.organizationId);
        return serveMark(organization.logo, `organization ${organization.id} has no raster mark to serve`);
      },
    );

    /**
     * A member's face.
     *
     * **Keyed by the membership, and resolved inside the acting organization** — so entitlement is the
     * roster the face is already drawn on, and a membership id from another account is the same 404 as
     * one that never existed. There is no arrangement of this path that asks whether a given *user* id is
     * real, which is the question `@pithy-sh/auth` declines to answer by serving only the caller's own.
     */
    app.get(
      `${base}${MEMBERS_PATH_SEGMENT}/:membershipId/image`,
      requireOrganization(deps),
      requirePower<Power, Role>("organization:read", deps),
      zValidator("param", MemberMarkParam, validationHook),
      async (c) => {
        const acting = c.var.acting;
        const database = db(c);
        const target = await requireMembershipInOrganization(
          database,
          catalog,
          acting.organizationId,
          c.req.valid("param").membershipId,
        );
        const person = (await readPeople(auth(c), [target.userId])).get(target.userId);
        // Null for a provider's link as well as for a vector: that URL is already somewhere else, and
        // `memberView` hands the client it directly rather than this path.
        return serveMark(person?.image ?? null, `membership ${target.id} has no raster face to serve`);
      },
    );

    // ── the management surface: two reads, and no writes ───────────────────────────────────────

    app.get(
      `${base}/admin/organizations`,
      gate(ORGANIZATION_ACCOUNTS_READ_SCOPE),
      zValidator("query", AdminListQuery, validationHook),
      async (c) => {
        const database = db(c);
        const limit = c.req.valid("query").limit ?? MAX_PAGE_SIZE;
        // One past the bound, so the flag is a fact rather than an inference from a full page.
        const rows = await database
          .selectFrom(ORGANIZATIONS_TABLE)
          .selectAll()
          .orderBy("createdAt", "desc")
          .orderBy("id", "desc")
          .limit(limit + 1)
          .execute();
        const page = rows.slice(0, limit).map((row) => Organization.parse(row));
        const counts = await memberCounts(
          database,
          page.map((organization) => organization.id),
        );
        return c.json({
          organizations: page.map((organization) =>
            adminOrganizationView(organization, counts.get(organization.id) ?? 0),
          ),
          truncated: rows.length > limit,
        } satisfies AdminOrganizationsResponse);
      },
    );

    app.get(
      `${base}/admin/organizations/:organizationId/members`,
      gate(ORGANIZATION_MEMBERS_READ_SCOPE),
      zValidator("param", AdminOrganizationParam, validationHook),
      zValidator("query", AdminListQuery, validationHook),
      async (c) => {
        const limit = c.req.valid("query").limit ?? MAX_PAGE_SIZE;
        // The limit goes to the statement, the way the accounts listing above does it. One row past the
        // bound comes back, so `truncated` is a fact the page carries rather than an inference from a
        // full one — and D1 is never asked for a whole tenant's roster to throw most of it away.
        const memberships = await listMembers(db(c), c.req.valid("param").organizationId, limit);
        const page = memberships.slice(0, limit);
        const people = await readPeople(
          auth(c),
          page.map((membership) => membership.userId),
        );
        return c.json({
          members: page.map((membership) => adminMemberView(membership, people.get(membership.userId))),
          truncated: memberships.length > limit,
        } satisfies AdminMembersResponse);
      },
    );
  };

  /** How many people each named organization holds, in one grouped statement per chunk. */
  async function memberCounts(
    database: OrganizationDatabase,
    organizationIds: readonly string[],
  ): Promise<Map<string, number>> {
    const counts = new Map<string, number>();
    for (let at = 0; at < organizationIds.length; at += ID_LOOKUP_CHUNK) {
      const chunk = organizationIds.slice(at, at + ID_LOOKUP_CHUNK);
      if (chunk.length === 0) continue;
      const rows = await database
        .selectFrom(MEMBERSHIPS_TABLE)
        .select((eb) => ["organizationId" as const, eb.fn.countAll<number>().as("total")])
        .where("organizationId", "in", chunk)
        .groupBy("organizationId")
        .execute();
      for (const row of rows) counts.set(row.organizationId, Number(row.total));
    }
    return counts;
  }
}

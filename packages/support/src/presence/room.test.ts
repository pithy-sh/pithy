// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import type { ActingOrganization } from "@pithy-sh/core/src/access/acting";
import type { Capability, PithyHonoEnv } from "@pithy-sh/core/src/capability/capability";
import {
  PRESENCE_ROOMS_BINDING_SPEC,
  PRESENCE_TICKET_KEY_SECRET,
  type PresenceSessionGate,
} from "@pithy-sh/core/src/presence/declaration";
import { configureSharedSecrets, resetSharedSecrets } from "@pithy-sh/secrets/src/sharedSecretsStore";
import type { Context } from "hono";
import { afterEach, describe, expect, test } from "vitest";
import { support } from "../capability";
import { SUPPORT_THREADS_READ_SCOPE } from "../http/scopes";
import { SUPPORT_THREAD_ACTIVITIES, SUPPORT_THREAD_ROOM, staffPresenceGate } from "./room";

/**
 * Support's one room kind: `support.thread`, behind `support:threads:read`, with `viewing` and `replying`.
 */

describe("the support.thread room", () => {
  test("is declared on core's seam behind support:threads:read, with viewing and replying", () => {
    const capability = support({ basePath: "/inbox" });
    expect(capability.presence?.basePath).toBe("/inbox");
    const rooms = capability.presence?.rooms ?? [];
    expect(rooms.map((room) => ({ kind: room.kind, scope: room.scope, activities: room.activities }))).toEqual([
      { kind: "support.thread", scope: SUPPORT_THREADS_READ_SCOPE, activities: ["viewing", "replying"] },
    ]);
    expect(SUPPORT_THREAD_ROOM).toBe("support.thread");
    expect(SUPPORT_THREAD_ACTIVITIES).toEqual(["viewing", "replying"]);
  });

  test("a participant starts as viewing, and the reply form is what announces replying", () => {
    // The first declared activity is what a participant joins as.
    expect(support().presence?.rooms[0]?.activities[0]).toBe("viewing");
  });

  test("declaring it wires the room's binding and socket, as core adds them", () => {
    const capability = support();
    expect(capability.requiredBindings.map((binding) => binding.name)).toContain(PRESENCE_ROOMS_BINDING_SPEC.name);
    expect(capability.sockets?.length).toBeGreaterThan(0);
  });

  test("without staff, the room admits management clients only", () => {
    expect(support().presence?.rooms[0]?.session).toBeUndefined();
  });
});

/** A context with a signed-in user acting for an organization whose role holds `powers`. */
function context(acting: ActingOrganization | null, env: Record<string, unknown> = {}): Context<PithyHonoEnv> {
  return {
    env,
    var: {
      auth: { userId: "u-7", sessionId: "s-1", scopes: [] },
      actingOrganization: async () => acting,
    },
  } as unknown as Context<PithyHonoEnv>;
}

const STAFF = { readPower: "support:read", assignPower: "support:assign" };

describe("staffPresenceGate", () => {
  test("admits a user whose acting role holds the read power, under their account's name", async () => {
    const gate = staffPresenceGate(STAFF, async () => ({ name: "Grace Hopper" }));
    const grant = await gate(
      context({ organizationId: "org", roleAllows: (power) => power === "support:read" }),
      "t-1",
    );
    expect(grant).toEqual({ name: "Grace Hopper" });
  });

  test("refuses a user without it, and a user acting for no organization", async () => {
    const gate = staffPresenceGate(STAFF, async () => ({ name: "Grace Hopper" }));
    expect(await gate(context({ organizationId: "org", roleAllows: () => false }), "t-1")).toBeNull();
    expect(await gate(context(null), "t-1")).toBeNull();
  });

  test("the assign power alone does not open the room", async () => {
    const gate = staffPresenceGate(STAFF, async () => null);
    const grant = await gate(
      context({ organizationId: "org", roleAllows: (power) => power === "support:assign" }),
      "t-1",
    );
    expect(grant).toBeNull();
  });

  test("a user whose account cannot be read joins under their id, which core supplies", async () => {
    const gate = staffPresenceGate(STAFF, async () => null);
    expect(await gate(context({ organizationId: "org", roleAllows: () => true }), "t-1")).toEqual({});
  });
});

/** An organization capability, by the shape support reads it, whose `staff` role holds both staff powers. */
const ORGANIZATION = {
  name: "organization",
  requiredBindings: [],
  organizationRoles: {
    powers: ["support:read", "support:assign"],
    roles: ["staff"],
    assignableRoles: [],
    roleAllows: () => true,
  },
} as unknown as Capability;

/** An auth capability, by the shape support's sender link reads it, holding one account: `u-7`, Grace Hopper. */
const AUTH = {
  name: "auth",
  requiredBindings: [],
  authConfig: {},
  authPeer: {
    authDatabase: () => ({
      selectFrom: () => ({
        selectAll: () => ({
          where: (_column: string, _op: string, id: string) => ({
            executeTakeFirst: async () =>
              id === "u-7" ? { id, email: "grace@example.com", name: "Grace Hopper", emailVerified: true } : undefined,
          }),
        }),
      }),
    }),
    User: { parse: (row: unknown) => row },
  },
} as unknown as Capability;

/** The session gate `support({ staff })` declares on its room, composed beside organization and auth. */
function declaredGate(): PresenceSessionGate {
  const capability = support({ staff: STAFF });
  capability.compose?.({ capabilities: [capability, ORGANIZATION, AUTH] } as never);
  const session = capability.presence?.rooms[0]?.session;
  if (!session) throw new Error("expected support({ staff }) to declare a session gate");
  return session;
}

describe("the room support({ staff }) declares", () => {
  const holding =
    (...powers: string[]): ActingOrganization["roleAllows"] =>
    (power) =>
      powers.includes(power);

  test("refuses a user whose acting role holds only the assign power", async () => {
    const gate = declaredGate();
    const acting = { organizationId: "org", roleAllows: holding("support:assign") };
    expect(await gate(context(acting, { DB: {} }), "t-1")).toBeNull();
  });

  test("refuses a user acting for no organization", async () => {
    expect(await declaredGate()(context(null, { DB: {} }), "t-1")).toBeNull();
  });

  test("admits a user whose acting role holds the read power, under the account's own name", async () => {
    const acting = { organizationId: "org", roleAllows: holding("support:read") };
    expect(await declaredGate()(context(acting, { DB: {} }), "t-1")).toEqual({ name: "Grace Hopper" });
  });

  test("with no DB binding to read the account from, admits under the user id, which core supplies", async () => {
    const acting = { organizationId: "org", roleAllows: holding("support:read") };
    expect(await declaredGate()(context(acting), "t-1")).toEqual({});
  });
});

describe("the presence ticket key", () => {
  afterEach(() => resetSharedSecrets());

  /** Point the shared secrets reader at a ticket key holding `versions`, with `currentVersion` current. */
  function ticketSecret(currentVersion: string, versions: Record<string, string>): void {
    configureSharedSecrets({
      registry: { [PRESENCE_TICKET_KEY_SECRET]: {} } as never,
      resolve: async () =>
        ({
          subset: () => ({
            getVersions: (name: string) => {
              if (name !== PRESENCE_TICKET_KEY_SECRET) throw new Error(`unexpected secret ${name}`);
              return { currentVersion, versions };
            },
          }),
        }) as never,
    });
  }

  async function keys(): Promise<readonly string[]> {
    const ticketKey = support().presence?.ticketKey;
    if (typeof ticketKey !== "function") throw new Error("expected support's ticket key to be read per request");
    const resolved = await ticketKey({});
    return typeof resolved === "string" ? [resolved] : resolved;
  }

  test("signs with the current version and still verifies the one it replaced", async () => {
    // The older version is listed first in the store, so the order is the function's and not the store's.
    ticketSecret("2", { "1": "old-key", "2": "new-key" });
    expect(await keys()).toEqual(["new-key", "old-key"]);
  });

  test("a key never rotated is one key", async () => {
    ticketSecret("1", { "1": "only-key" });
    expect(await keys()).toEqual(["only-key"]);
  });

  test("a current version with no value signs with none of its own, and the retained ones still verify", async () => {
    ticketSecret("3", { "1": "old-key", "2": "older-key" });
    expect(await keys()).toEqual(["old-key", "older-key"]);
  });
});

describe("support({ staff }) at compose", () => {
  const STAFFED = { staff: { readPower: "support:read", assignPower: "support:assign" } };

  test("declares both staff powers, so tenancy refuses a catalog that places them on no role", () => {
    expect(support(STAFFED).powers).toEqual(["support:read", "support:assign"]);
    expect(support().powers).toBeUndefined();
  });

  test("refuses to compose without organization, since nobody could ever hold a staff power", () => {
    const capability = support(STAFFED);
    expect(() => capability.compose?.({ capabilities: [capability] } as never)).toThrow(/organization/);
  });

  test("composes without staff exactly as it always did", () => {
    // The submission channel off, so the one other compose-time requirement — auth for in-app writes — is
    // not what this asserts.
    const capability = support({ submission: { enabled: false } });
    expect(() => capability.compose?.({ capabilities: [capability] } as never)).not.toThrow();
  });
});

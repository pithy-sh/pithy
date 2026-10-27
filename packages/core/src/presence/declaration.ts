// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import type { Context } from "hono";
import type { BindingSpecInput } from "../capability/bindings";
import type { PithyHonoEnv } from "../capability/capability";
import { remedy } from "../cli/command";
import { ControlPlaneScope } from "../controlPlane/scope/scope";
import { InternalError } from "../error/pithyError";
import { PRESENCE_PARTICIPANT_NAME_MAX } from "./frames";
import { PresenceActivity, PresenceRoomKindName } from "./names";

/**
 * **Presence rooms: who else has a record open, live, from the adopter's own Worker.**
 *
 * A capability declares the room kinds it serves beside its admin routes, on {@link Capability.presence}: a
 * name (`support.thread`), the control-plane scope that reads the record (`support:threads:read`), and the
 * activities a participant may announce (`viewing`, `replying`). A room is one kind plus one record id, and
 * it lives in one hibernating Durable Object, `PresenceRoom`, that holds nothing but who is in it.
 *
 * Joining takes a **ticket**, because a browser's `WebSocket` sets no headers and so cannot carry either the
 * control-plane token or, cross-origin, a session cookie. A ticket is minted by one of two routes — the
 * control-plane one behind the kind's scope, or the capability's own session one behind its own read
 * permission — and presented once, in the subprotocol offer, within 60 seconds.
 *
 * **Presence adds no scope of its own.** Anyone who may read a record may see who else has it open, so the
 * room kind names the scope that already reads the record and the session gate the capability already has.
 *
 * This module is pure: zod, types and constants. The routes are in `./http/routes.ts`, the Durable Object in
 * `./durableObject.ts`, and nothing here imports either.
 */

/** The Durable Object binding every room lives behind. One namespace for every room kind in a Worker. */
export const PRESENCE_ROOMS_BINDING = "PRESENCE_ROOMS";

/** The class that backs {@link PRESENCE_ROOMS_BINDING}, and the module the Worker's entry re-exports it from. */
export const PRESENCE_ROOM_CLASS = "PresenceRoom";

/** Its own module, never a package entry point, so `pithy.config.ts` can load the capability in Node. */
export const PRESENCE_ROOM_MODULE = "@pithy-sh/core/src/presence/durableObject";

/**
 * The binding a capability that declares room kinds requires. `defineCapability` adds it, so a capability
 * never spells it; a kit capability's `pithy.manifest.json` names it exactly as written here, which is what
 * `pithy add` and `pithy upgrade` wire through the Durable Object path (#428).
 */
export const PRESENCE_ROOMS_BINDING_SPEC: BindingSpecInput = {
  type: "durable_object",
  name: PRESENCE_ROOMS_BINDING,
  className: PRESENCE_ROOM_CLASS,
  classModule: PRESENCE_ROOM_MODULE,
};

/**
 * The secret tickets are signed with: one per Worker environment, generated, never typed. A capability that
 * declares room kinds declares this name in its `@pithy-sh/secrets` registry with {@link
 * PRESENCE_TICKET_KEY_ENTRY} and reads it through `secretsStore`, and its manifest lists it under
 * `devSecrets` so `pithy add` mints the local value. The name is the join key, so every capability that
 * declares rooms in one Worker signs and verifies with the one key.
 */
export const PRESENCE_TICKET_KEY_SECRET = "presence-ticket-key";

/**
 * The registry entry for {@link PRESENCE_TICKET_KEY_SECRET}, in the shape `defineSecretRegistry` takes. Its
 * value is arbitrary — nothing outside the Worker has to agree with it — so it is `devValue: "random"`, and
 * rotatable because {@link PresenceTicketKey} accepts every version still honored.
 */
export const PRESENCE_TICKET_KEY_ENTRY = {
  backend: "d1",
  scope: "environment",
  rotatable: true,
  valueType: "text",
  devValue: "random",
} as const;

/** How long a minted ticket is honored, in seconds. Long enough to open a socket, short enough to be useless later. */
export const PRESENCE_TICKET_TTL_SECONDS = 60;

/** The participant cap a room kind gets when it declares none. */
export const DEFAULT_PRESENCE_PARTICIPANTS = 25;

/** The most participants any room kind may declare. A room is one Durable Object, and every frame fans out to all of them. */
export const MAX_PRESENCE_PARTICIPANTS = 100;

/** The largest frame a room accepts from a client, in bytes. The one frame a client sends is an activity name. */
export const PRESENCE_MAX_FRAME_BYTES = 1024;

/** The most activities one room kind may declare. */
export const MAX_PRESENCE_ACTIVITIES = 16;

/** What the session gate grants: the participant's display name, or the user id when it names none. */
export interface PresenceSessionGrant {
  /**
   * How other participants see this user. Trimmed and cut to 80 characters; the user id when it is missing
   * or blank, so a gate can pass a stored display name through as it is.
   */
  readonly name?: string;
}

/**
 * The name a session participant joins under: the gate's, trimmed and cut to fit, or the user id when the
 * gate names none or a blank one. Always a name a ticket accepts — a display name is the user's own data, and
 * one too long or empty must not lock them out of every room.
 */
export function sessionParticipantName(name: string | undefined, userId: string): string {
  return fitName(name ?? "") || fitName(userId) || "Participant";
}

/** Trim, then cut to {@link PRESENCE_PARTICIPANT_NAME_MAX} code units without splitting a character. */
function fitName(raw: string): string {
  let fitted = "";
  for (const char of raw.trim()) {
    if (fitted.length + char.length > PRESENCE_PARTICIPANT_NAME_MAX) break;
    fitted += char;
  }
  return fitted.trim();
}

/**
 * The capability's own permission for reading one record, for a signed-in user of the app. Answer a grant
 * to admit, `null` to refuse. `c.var.auth` is already set when it runs; it is the capability's job to say
 * whether that user may read `recordId`, exactly as its own read route would.
 */
export type PresenceSessionGate = (
  c: Context<PithyHonoEnv>,
  recordId: string,
) => PresenceSessionGrant | null | Promise<PresenceSessionGrant | null>;

/** One room kind a capability serves. */
export interface PresenceRoomKind {
  /** The kind's name — `support.thread`. Its first segment must be the declaring capability's name. */
  readonly kind: string;
  /** The control-plane scope that reads the record. A management client joins with exactly this scope. */
  readonly scope: string;
  /** The activities a participant may announce. The first is what a participant starts as. */
  readonly activities: readonly [string, ...string[]];
  /** The participant cap. Defaults to {@link DEFAULT_PRESENCE_PARTICIPANTS}, at most {@link MAX_PRESENCE_PARTICIPANTS}. */
  readonly maxParticipants?: number;
  /**
   * Who of the app's own signed-in users may join: the capability's read permission for the record. Absent,
   * the kind admits management clients only and the session ticket route refuses it.
   */
  readonly session?: PresenceSessionGate;
}

/**
 * The secret tickets are signed with: the value, every value still honored during a rotation (the first
 * signs), or a resolver reading it from the Worker env per request — which is the only form a secret read
 * through `@pithy-sh/secrets` can take, since `env` exists only per request.
 */
export type PresenceTicketKey =
  | string
  | readonly string[]
  | ((env: Record<string, unknown>) => string | readonly string[] | Promise<string | readonly string[]>);

/** A capability's presence declaration — see {@link Capability.presence}. */
export interface PresenceDeclaration {
  /**
   * Where this capability mounts its presence routes: `{basePath}/presence/tickets` and
   * `{basePath}/presence/rooms/:kind/:recordId`. The capability's own resolved `basePath`, never its default.
   */
  readonly basePath: string;
  /** The room kinds it serves. */
  readonly rooms: readonly PresenceRoomKind[];
  /** The ticket signing key — {@link PRESENCE_TICKET_KEY_SECRET}, read through the capability's own secrets reader. */
  readonly ticketKey: PresenceTicketKey;
}

/** The session ticket route, under a capability's base path. */
export function presenceTicketPath(basePath: string): string {
  return `${basePath}/presence/tickets`;
}

/** The socket route, under a capability's base path, as Hono registers it. */
export function presenceSocketPath(basePath: string): string {
  return `${basePath}/presence/rooms/:kind/:recordId`;
}

/** The socket path for one room, ready to open. */
export function presenceRoomPath(basePath: string, kind: string, recordId: string): string {
  return `${basePath}/presence/rooms/${encodeURIComponent(kind)}/${encodeURIComponent(recordId)}`;
}

/** The participant cap a room kind runs with. */
export function participantCap(room: PresenceRoomKind): number {
  return room.maxParticipants ?? DEFAULT_PRESENCE_PARTICIPANTS;
}

/** One of the capability's own admin routes, as far as the scope rule reads it: its method and the scope it requires. */
export interface PresenceGatingRoute {
  method: string;
  scope: string | null;
}

/**
 * Refuse a declaration no room could be served from, where it is written and naming the capability: a kind
 * outside the capability's own name, a duplicate, a scope that is not one, an activity that is not one, a
 * cap out of range. A declaration that reached a request would be refused there, by a caller, in a way only
 * the operator can fix.
 *
 * **A room kind's scope is one the capability's own admin routes already require, and only `GET`s require
 * it** — compared against `adminRoutes`, the same artifact `capabilityHealthSources` polices health keys
 * with, and for the same reason. `pithy dashboard connect` offers the scopes it reads off `adminRoutes`, so
 * a scope no route requires — one of presence's own, a near-miss, another capability's — is never offered
 * and never in the default grant, and the room is unjoinable from every management client with no error to
 * say why. And a scope that also gates a write would make joining a room need a mutation grant, which
 * inverts the read rule `grant.ts` applies.
 */
export function assertPresenceDeclaration(
  capability: string,
  presence: PresenceDeclaration,
  adminRoutes: readonly PresenceGatingRoute[],
): void {
  const refuse = (detail: string): never => {
    throw new InternalError({
      message: `${capability} declares presence rooms this Worker cannot serve.`,
      action: `Fix the presence declaration on the ${capability} capability.`,
      detail,
    });
  };
  if (!presence.basePath.startsWith("/") || presence.basePath.endsWith("/")) {
    refuse(`presence basePath "${presence.basePath}" must start with "/" and not end with one`);
  }
  const seen = new Set<string>();
  for (const room of presence.rooms) {
    if (!PresenceRoomKindName.safeParse(room.kind).success) refuse(`room kind "${room.kind}" is not a kind name`);
    if (!room.kind.startsWith(`${capability}.`)) {
      refuse(
        `room kind "${room.kind}" must start with "${capability}." — a capability declares kinds under its own name`,
      );
    }
    if (seen.has(room.kind)) refuse(`room kind "${room.kind}" is declared twice`);
    seen.add(room.kind);
    if (!ControlPlaneScope.safeParse(room.scope).success)
      refuse(`room kind "${room.kind}" scope "${room.scope}" is not a scope`);
    // Inherited, never invented: the scope a room joins with is one this capability already gates a read with.
    const gating = adminRoutes.filter((route) => route.scope === room.scope);
    if (gating.length === 0) {
      refuse(
        `room kind "${room.kind}" scope "${room.scope}": no admin route of ${capability} requires it, so no grant would ever offer it`,
      );
    }
    const write = gating.find((route) => route.method !== "GET");
    if (write) {
      refuse(
        `room kind "${room.kind}" scope "${room.scope}" gates a ${write.method}; a room joins with a read scope, one only GET routes require`,
      );
    }
    if (room.activities.length === 0 || room.activities.length > MAX_PRESENCE_ACTIVITIES) {
      refuse(
        `room kind "${room.kind}" declares ${room.activities.length} activities; it needs 1 to ${MAX_PRESENCE_ACTIVITIES}`,
      );
    }
    if (new Set(room.activities).size !== room.activities.length) {
      refuse(`room kind "${room.kind}" declares an activity twice`);
    }
    for (const activity of room.activities) {
      if (!PresenceActivity.safeParse(activity).success)
        refuse(`room kind "${room.kind}" activity "${activity}" is not one word`);
    }
    const cap = participantCap(room);
    if (!Number.isInteger(cap) || cap < 1 || cap > MAX_PRESENCE_PARTICIPANTS) {
      refuse(`room kind "${room.kind}" maxParticipants ${cap} is outside 1 to ${MAX_PRESENCE_PARTICIPANTS}`);
    }
  }
}

/**
 * The ticket signing keys, resolved and non-empty — the first signs, every one verifies. A blank entry is
 * dropped rather than tried, since WebCrypto refuses a zero-length key with an error that names nothing.
 */
export async function resolveTicketKeys(key: PresenceTicketKey, env: Record<string, unknown>): Promise<string[]> {
  const resolved = typeof key === "function" ? await key(env) : key;
  const keys = (typeof resolved === "string" ? [resolved] : [...resolved]).filter((value) => value.length > 0);
  if (keys.length === 0) {
    throw new InternalError({
      message: "Presence is not available right now.",
      action: `Set ${PRESENCE_TICKET_KEY_SECRET}. ${remedy("secrets provision", {}, { runtime: true }).say((command) => `${command} mints it for each environment.`)}`,
      detail: `${PRESENCE_TICKET_KEY_SECRET} resolved to no usable value`,
    });
  }
  return keys;
}

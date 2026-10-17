// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { type RawBuilder, type SqlBool, sql } from "kysely";
import type { PithyVars } from "../capability/capability";
import type { ActingOrganization } from "./acting";
import type { RecordVisibility } from "./visibility";

/**
 * Who may read a record, and who may change it — the rules media and storage both enforce, and the one
 * hook an adopter answers to change them.
 *
 * ## The rules
 *
 * | Level          | Who reads it                                                       |
 * |----------------|--------------------------------------------------------------------|
 * | `private`      | The owner, acting for the organization the record was written under. |
 * | `organization` | Any member of the record's organization, acting for it.            |
 * | `public`       | Anyone holding the id or URL, signed in or not.                    |
 *
 * **Writing** — editing, deleting, changing visibility — is the owner's, acting for the record's
 * organization, and that of a role holding the capability's manage power (`media:manage`,
 * `storage:manage`) in the record's organization, so an organization can clean up after somebody who
 * left. The manage power admits reading too: a record you may delete is a record you may see.
 *
 * **The organization is compared as recorded, null included.** A record written with no organization in
 * force is its owner's while no organization is in force, and nobody's otherwise — not a manager's, since
 * a power is only ever held *in* an organization. A record with no owner and no organization is the
 * system's, and no rule reaches it; the hook is the only thing that can.
 *
 * ## The hook: allow, deny, or the default
 *
 * Asked on every read and every write. **Allow** admits — sharing a record with one person. **Deny**
 * removes — a legal hold. **Default** is the rules above, and no hook at all is the rules unchanged.
 * Sharing itself stays the adopter's: their grants, their requests for access, their tables. The hook is
 * handed the Worker env so it can read them.
 *
 * **On a list, a deny filters and a grant does not list.** The rules run in SQL ({@link
 * readablePredicate}); the hook is asked about each row on the page ({@link keepReadable}) and may only
 * remove one. A record the hook grants is reached by id, and the adopter lists their own grants from
 * their own tables.
 *
 * **The hook governs the record routes and nothing else.** Duplicate detection and control-plane rollups
 * keep their non-disclosure rules whatever it answers: a hook that widened a per-subject total would
 * reopen exactly the disclosure those rules close.
 */

/** Who is asking: the signed-in person, if any, and the organization they act for, if any. */
export interface AccessCaller {
  /** The signed-in user, from `c.var.auth.userId`; `null` for an anonymous caller. */
  readonly userId: string | null;
  /** The organization in force, from the acting-organization seam; `null` when none is. */
  readonly acting: ActingOrganization | null;
}

/** The fields of a record the rules read. Every capability holding a person's record carries these. */
export interface AccessRecord {
  /** The record's id — handed to the hook so it can look up a grant. */
  readonly id: string;
  /** The user who owns it, or `null` for a system-owned record. */
  readonly ownerId: string | null;
  /** The organization in force when it was written, or `null` when none was. */
  readonly organizationId: string | null;
  /** Who may read it. */
  readonly visibility: RecordVisibility;
}

/** What the hook is asked about. Reading, or changing — editing, deleting, changing visibility. */
export type AccessAction = "read" | "write";

/** The hook's answer. `default` defers to the rules. */
export type PermissionDecision = "allow" | "deny" | "default";

/** Everything the hook is told. */
export interface PermissionRequest {
  /** What the caller is trying to do. */
  readonly action: AccessAction;
  /** Which capability holds the record — `media` or `storage` — so one hook can serve both. */
  readonly capability: string;
  /** The record, as the rules see it. */
  readonly record: AccessRecord;
  /** Who is asking, as ids. */
  readonly caller: { readonly userId: string | null; readonly organizationId: string | null };
  /** The Worker env, so the hook can read the adopter's own grant tables through their own bindings. */
  readonly env: Record<string, unknown>;
}

/** The one hook an adopter supplies. May be async — a grant lives in a table. */
export type PermissionHook = (request: PermissionRequest) => PermissionDecision | Promise<PermissionDecision>;

/** What a caller may do with one record. */
export type AccessLevel = "none" | "read" | "write";

/** The organization a caller acts for, as an id. */
function organizationOf(caller: AccessCaller): string | null {
  return caller.acting?.organizationId ?? null;
}

/** Whether the caller acts for the organization the record was written under — null matching null. */
function actsForRecord(record: AccessRecord, caller: AccessCaller): boolean {
  return record.organizationId === organizationOf(caller);
}

/** Whether the caller is the record's owner, acting for the record's organization. */
function isActingOwner(record: AccessRecord, caller: AccessCaller): boolean {
  return caller.userId !== null && record.ownerId === caller.userId && actsForRecord(record, caller);
}

/** Whether the caller holds the manage power in the record's organization. Never for a null organization. */
function managesRecord(record: AccessRecord, caller: AccessCaller, managePower: string): boolean {
  return (
    caller.userId !== null &&
    record.organizationId !== null &&
    caller.acting !== null &&
    caller.acting.organizationId === record.organizationId &&
    caller.acting.roleAllows(managePower)
  );
}

/** The rules alone, with no hook — what `default` means. */
export function defaultAllows(
  action: AccessAction,
  record: AccessRecord,
  caller: AccessCaller,
  managePower: string,
): boolean {
  if (isActingOwner(record, caller) || managesRecord(record, caller, managePower)) return true;
  if (action === "write") return false;
  switch (record.visibility) {
    case "public":
      return true;
    case "organization":
      return caller.userId !== null && record.organizationId !== null && actsForRecord(record, caller);
    case "private":
      return false;
  }
}

/** A record's owner and organization, as one reader may be told them. */
export interface DisclosedTenancy {
  readonly ownerId: string | null;
  readonly organizationId: string | null;
}

/**
 * Who holds a record, as this reader may learn it: the owner and organization when the reader is signed in
 * and acts for the record's organization (none matching none), and neither otherwise.
 *
 * **Reading a record is not learning who holds it.** A public record is anyone's to read, but its owner's
 * id beside its organization's id says that person belongs to that organization — and a list with
 * `includePublic=true` reaches public records in every organization. An organization never learns that one
 * of its people holds an account in another, so a record read from outside its organization, or by nobody
 * in particular, names neither. Making a file public is a choice about the file, not about its owner.
 *
 * Every view a client sees of a media record or a stored file passes through this.
 */
export function disclosedTenancy(record: AccessRecord, caller: AccessCaller): DisclosedTenancy {
  if (caller.userId === null || !actsForRecord(record, caller)) return { ownerId: null, organizationId: null };
  return { ownerId: record.ownerId, organizationId: record.organizationId };
}

/** What {@link accessLevel} needs: the record, the caller, the capability's power, and the hook if any. */
export interface AccessOptions {
  /** The record being reached. */
  readonly record: AccessRecord;
  /** Who is reaching it. */
  readonly caller: AccessCaller;
  /** The capability's name, as the hook sees it. */
  readonly capability: string;
  /** The capability's manage power — `media:manage`, `storage:manage`. */
  readonly managePower: string;
  /** The adopter's hook, if they supplied one. */
  readonly hook?: PermissionHook;
  /** The Worker env, for the hook. */
  readonly env: Record<string, unknown>;
}

/** Ask the hook, then the rules where it defers. */
async function decide(action: AccessAction, options: AccessOptions): Promise<boolean> {
  const fallback = () => defaultAllows(action, options.record, options.caller, options.managePower);
  if (!options.hook) return fallback();
  const decision = await options.hook({
    action,
    capability: options.capability,
    record: options.record,
    caller: { userId: options.caller.userId, organizationId: organizationOf(options.caller) },
    env: options.env,
  });
  if (decision === "allow") return true;
  if (decision === "deny") return false;
  return fallback();
}

/**
 * What the caller may do with one record: nothing, read it, or change it.
 *
 * Read is decided first, and write is never asked about a record the caller cannot read — so a record
 * the caller cannot see answers `none`, which a route turns into **not found**, never forbidden. Only a
 * caller who may already read a record can learn it is not theirs to change.
 */
export async function accessLevel(options: AccessOptions): Promise<AccessLevel> {
  if (!(await decide("read", options))) return "none";
  return (await decide("write", options)) ? "write" : "read";
}

/** What {@link keepReadable} needs. The rules already ran in SQL, so no power is consulted here. */
export interface KeepReadableOptions {
  readonly capability: string;
  readonly caller: AccessCaller;
  readonly hook?: PermissionHook;
  readonly env: Record<string, unknown>;
}

/**
 * Ask the hook about every row on a page and drop the ones it denies.
 *
 * Only a deny changes anything: the rows arrived through {@link readablePredicate}, so the rules already
 * admitted them, and an allow cannot add a row that was never on the page. A page can come back short;
 * the capability's cursor is computed before this runs, so a short page still says there is more.
 */
export async function keepReadable<Row extends AccessRecord>(
  rows: readonly Row[],
  options: KeepReadableOptions,
): Promise<Row[]> {
  const hook = options.hook;
  if (!hook) return [...rows];
  const kept: Row[] = [];
  for (const row of rows) {
    const decision = await hook({
      action: "read",
      capability: options.capability,
      record: row,
      caller: { userId: options.caller.userId, organizationId: organizationOf(options.caller) },
      env: options.env,
    });
    if (decision !== "deny") kept.push(row);
  }
  return kept;
}

/** What a list asks for beyond the rules. */
export interface ReadablePredicateOptions {
  /** The capability's manage power — a holder lists every record in their organization. */
  readonly managePower: string;
  /** Add every public record. Off by default: nobody receives what they did not ask for. */
  readonly includePublic?: boolean;
}

/**
 * The rules, in SQL — the `where` a list runs, over a table carrying `owner_id`, `organization_id` and
 * `visibility`.
 *
 * **A list returns the caller's own records and their organization's.** Their own is every record they
 * own in the organization they act for (or in none, while none is in force). Their organization's is every
 * record in it whose visibility admits members, and every record at all for a holder of the manage power.
 * `includePublic` adds every public record, and nothing else does.
 *
 * `sql.ref` rather than a typed builder, so one predicate serves every capability's table; the
 * `CamelCasePlugin` still snake-cases each reference. Values are bound parameters, never interpolated.
 */
export function readablePredicate(caller: AccessCaller, options: ReadablePredicateOptions): RawBuilder<SqlBool> {
  const owner = sql.ref("ownerId");
  const organization = sql.ref("organizationId");
  const visibility = sql.ref("visibility");
  const organizationId = organizationOf(caller);
  const clauses: RawBuilder<SqlBool>[] = [];

  if (caller.userId !== null) {
    clauses.push(
      organizationId === null
        ? sql<SqlBool>`(${owner} = ${caller.userId} and ${organization} is null)`
        : sql<SqlBool>`(${owner} = ${caller.userId} and ${organization} = ${organizationId})`,
    );
  }
  if (caller.userId !== null && organizationId !== null) {
    clauses.push(
      caller.acting?.roleAllows(options.managePower)
        ? sql<SqlBool>`(${organization} = ${organizationId})`
        : sql<SqlBool>`(${organization} = ${organizationId} and ${visibility} in ('organization', 'public'))`,
    );
  }
  if (options.includePublic) clauses.push(sql<SqlBool>`(${visibility} = 'public')`);

  if (clauses.length === 0) return sql<SqlBool>`0 = 1`;
  return sql<SqlBool>`(${sql.join(clauses, sql` or `)})`;
}

/**
 * The caller, from a request: the signed-in user and the organization they act for.
 *
 * An anonymous caller never resolves an organization — there is no session to resolve one from, and not
 * asking keeps a public read from paying for a tenancy query it cannot use.
 */
export async function accessCaller(vars: Pick<PithyVars, "auth" | "actingOrganization">): Promise<AccessCaller> {
  const userId = vars.auth?.userId ?? null;
  if (userId === null) return { userId: null, acting: null };
  return { userId, acting: await vars.actingOrganization() };
}

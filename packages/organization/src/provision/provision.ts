// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import type { D1Database, D1PreparedStatement, D1Result } from "@cloudflare/workers-types";
import { withD1Retry } from "@pithy-sh/core/src/data/withD1Retry";
import { fromZodError, InternalError } from "@pithy-sh/core/src/error/pithyError";
import { StoredImage } from "@pithy-sh/core/src/image/storedImage";
import type { CompiledQuery } from "kysely";
import { z } from "zod";
import { Membership } from "../data/membership";
import { Organization } from "../data/organization";
import {
  ACTING_TABLE,
  INVITATIONS_TABLE,
  MEMBERSHIPS_TABLE,
  ORGANIZATIONS_TABLE,
  OWNERSHIP_NOMINATIONS_TABLE,
  organizationDatabase,
} from "../data/tables";
import {
  OrganizationInvalidRoleCatalogError,
  OrganizationNotFoundError,
  OrganizationSlugTakenError,
} from "../error/errors";
import type { RoleCatalog } from "../roles/roles";

/**
 * The life of the account itself: founding one, changing it, ending it.
 *
 * ## Founding writes two rows, and they are one fact
 *
 * An organization with no membership is an account nobody can administer — and nobody can rename,
 * delete, invite into, or even see, because every route in this capability starts from a membership
 * rather than from an organization id. There is no repair path short of a hand-written statement
 * against production. So the insert is a single `d1.batch`, which D1 runs as one transaction: both rows
 * land, or neither does.
 *
 * That is also why founding is a function rather than two calls in a handler. A handler that inserts an
 * organization and then inserts a membership is correct until the second statement fails, and the
 * second statement fails on the day D1 is having one.
 *
 * **`batch` is D1's, not Kysely's**, so this module takes the raw binding and compiles queries to
 * prepared statements through {@link compile} — the same shape `@pithy-sh/payments`' projection writer
 * uses. Kysely is still what builds every statement, so the table and column names here stay camelCase
 * and `CamelCasePlugin` owns the boundary.
 *
 * ## The founder's role comes from the catalog, and not from the call site
 *
 * Provisioning with a role argument would make *create an organization you cannot administer* reachable
 * from a typo, in the one act that has no gate in front of it — the caller is not yet a member of
 * anything, so there is nothing to check them against.
 *
 * **From the catalog rather than from `OrganizationConfig`**, and the argument is that the answer is
 * already there. The catalog knows which roles administer (`administers`) and which roles may be handed
 * over at all (`assignableRoles`, derived by exclusion). A config field would be a second place to say
 * something the matrix has already said, and a deployment could then name a role the catalog does not
 * declare — a boot-time failure invented to serve a setting nobody needed.
 *
 * So: **the first declared role that administers and is assignable.** {@link founderRole} is the whole
 * of it, and the two halves each carry their weight.
 *
 * *Administers*, because somebody has to be able to run what they just made.
 *
 * *Assignable*, because **being first is not owning**. A role excluded from assignment is one this
 * capability may not hand anybody — that is what the exclusion means — and the dashboard's `owner` is
 * exactly that: ownership is who pays the bill and signs, so it is accepted rather than conferred, it
 * moves only by a two-party transfer, and a new organization therefore has none. Such an account works
 * — it can be administered, invited into and read — and it cannot be billed, which is the model saying
 * out loud that nobody has yet agreed to pay for it. A catalog that excludes nothing, like the
 * academy's, gets its `owner` as the founder, which is the same rule reaching a different answer
 * because the catalog said something different.
 *
 * ## The slug is never changed here, and there is no function that changes it
 *
 * `data/organization.ts` calls a slug stable on purpose: every link, bookmark and audit entry addresses
 * the organization by it. A display name is free text and changing it breaks nothing; changing an
 * address breaks everything that ever wrote one down. They are two acts and only one of them is here.
 */

/** Compile a Kysely query to a D1 prepared statement, so it can join a `batch` transaction. */
function compile(d1: D1Database, query: { compile(): CompiledQuery }): D1PreparedStatement {
  const compiled = query.compile();
  return d1.prepare(compiled.sql).bind(...(compiled.parameters as unknown[]));
}

/**
 * The role a founder is given: the first declared role that administers and may be assigned.
 *
 * Exported because it is a fact about a catalog rather than an implementation detail of one function —
 * a scaffolded starter matrix wants to name it in a comment, and a test wants to pin it.
 *
 * A catalog whose only administering roles are excluded from assignment is refused here rather than at
 * boot, because `defineRoles` cannot know that this capability founds accounts — but the refusal still
 * names the catalog, not the request, because that is what is wrong.
 */
export function founderRole<Power extends string, Role extends string>(catalog: RoleCatalog<Power, Role>): Role {
  const found = catalog.assignableRoles.find((role) => catalog.administers(role));
  if (found === undefined) {
    throw new OrganizationInvalidRoleCatalogError({
      message: "This project's roles leave nobody who could found an organization.",
      action: `Leave at least one role holding \`${catalog.administrativePower}\` out of \`unassignable\`.`,
      detail: `no assignable role holds ${catalog.administrativePower}; assignable roles are ${catalog.assignableRoles.join(", ") || "(none)"}`,
    });
  }
  return found;
}

/** What founding an organization needs. */
export interface CreateOrganizationInput {
  /** The display name, as somebody typed it. Bounded by the column's own schema. */
  readonly name: string;
  /** The URL-safe short name. Unique across every organization; a collision refuses, never renames. */
  readonly slug: string;
  /**
   * The signed-in person founding it. Becomes {@link founderRole} — there is no second option.
   *
   * Named `founderUserId` rather than `ownerUserId`, because the word was the bug: whoever creates an
   * organization is its founder, and ownership is a separate thing somebody accepts.
   */
  readonly founderUserId: string;
  /** The clock. One instant for both rows, injected so a test is deterministic. */
  readonly now?: Date;
  /** The id source. A seam: production passes nothing and gets `crypto.randomUUID`. */
  readonly newId?: () => string;
}

/** What was founded. Returned decoded, so a caller never re-reads what it just wrote. */
export interface CreatedOrganization {
  /** The account. */
  readonly organization: Organization;
  /** The founder's membership — the row that makes the account reachable at all. */
  readonly membership: Membership;
}

/**
 * Found an organization and make its founder an administrator. One D1 batch, so the pair is atomic.
 *
 * A taken slug refuses with {@link OrganizationSlugTakenError}, decided by asking the database *after*
 * the write failed rather than by checking first. A check-then-insert has a window between the two, and
 * the window is exactly where two people naming their organization the same thing at the same moment
 * land — one of them would get a 201 for a row that is not there.
 */
export async function createOrganization<Power extends string, Role extends string>(
  d1: D1Database,
  catalog: RoleCatalog<Power, Role>,
  input: CreateOrganizationInput,
): Promise<CreatedOrganization> {
  const now = input.now ?? new Date();
  const newId = input.newId ?? (() => crypto.randomUUID());
  const role = founderRole(catalog);

  // No logo. An account begins without one and a caller draws initials for it, which is an answer
  // rather than a placeholder — there is nothing here to ask a founder for at founding time.
  const organization = {
    id: newId(),
    name: input.name,
    slug: input.slug,
    logo: null,
    createdAt: now,
    updatedAt: now,
  };
  const membership = {
    id: newId(),
    organizationId: organization.id,
    userId: input.founderUserId,
    role,
    createdAt: now,
  };

  // Encoded through each table's own codec, which is also where the slug's pattern and the name's
  // bounds are enforced — the same definition the read path uses, so a bad slug cannot reach D1 by
  // arriving through a caller that skipped a form.
  let rows: { organization: z.input<typeof Organization>; membership: z.input<typeof Membership> };
  try {
    rows = { organization: Organization.encode(organization), membership: Membership.encode(membership) };
  } catch (cause) {
    if (cause instanceof z.ZodError) throw fromZodError(cause);
    throw cause;
  }

  const db = organizationDatabase(d1);
  let written: D1Result<unknown>[] | undefined;
  try {
    written = await withD1Retry<D1Result<unknown>[] | undefined>(() =>
      d1.batch([
        compile(d1, db.insertInto(ORGANIZATIONS_TABLE).values(rows.organization)),
        compile(d1, db.insertInto(MEMBERSHIPS_TABLE).values(rows.membership)),
      ]),
    );
  } catch (cause) {
    throw foundingFailure(
      (await organizationIdWithSlug(d1, input.slug)) !== undefined,
      input.slug,
      cause instanceof Error ? cause.name : "unknown",
      cause,
    );
  }

  // `undefined` is `withD1Retry`'s idempotency guard: a unique-constraint failure on a *retry*, which it
  // reads as "my own earlier attempt already committed and only its transport hiccupped". That inference
  // is sound only for a key nobody else can hold, and ours is a slug anybody may take — during the
  // backoff another account can claim it. So ask who holds the slug now. Ours means the first attempt did
  // land; anybody else's means the batch rolled back, and answering success here would hand the caller an
  // id and a slug that are in no row.
  if (written === undefined) {
    const holder = await organizationIdWithSlug(d1, input.slug);
    if (holder !== organization.id) {
      throw foundingFailure(holder !== undefined, input.slug, "a unique constraint on retry left no row");
    }
  }

  return { organization: Organization.parse(rows.organization), membership: Membership.parse(rows.membership) };
}

/**
 * Who holds the slug, asked after the failure — before it, the answer expires.
 *
 * The id and not merely a boolean, because the retry path has to tell our own committed row from a
 * stranger's. "A row exists with this slug" is true in both cases and useful in neither.
 */
async function organizationIdWithSlug(d1: D1Database, slug: string): Promise<string | undefined> {
  const existing = await organizationDatabase(d1)
    .selectFrom(ORGANIZATIONS_TABLE)
    .select("id")
    .where("slug", "=", slug)
    .executeTakeFirst();
  return existing?.id;
}

/**
 * Turn a failed batch into the refusal a caller can act on.
 *
 * `reason` is a phrase we chose — the cause's *name*, never its message. A D1 error message can quote
 * the statement, and the statement carries the organization's name and the founder's user id; `detail`
 * reaches logs and the audit trail verbatim, so it says the shape of the failure and never its content.
 */
function foundingFailure(taken: boolean, slug: string, reason: string, cause?: unknown): Error {
  if (taken) {
    return new OrganizationSlugTakenError({ detail: `organization slug ${slug} already exists` }, { cause });
  }
  return new InternalError(
    { message: "The organization could not be created.", detail: `founding ${slug} failed (${reason})` },
    { cause },
  );
}

/** What a rename needs. The slug is not among them, and there is no function here that changes one. */
export interface RenameOrganizationInput {
  /** Which account. Resolved from the acting selection by the caller, never from a request field. */
  readonly organizationId: string;
  /** The new display name. Held to the column's own bounds, so a caller that skipped a form still is. */
  readonly name: string;
  /** The clock, so a test is deterministic — and so `updatedAt` matches the instant a mark was served at. */
  readonly now?: Date;
}

/**
 * Change the display name.
 *
 * Validated against the column's own schema rather than a restatement of it: a name is rendered in every
 * chooser, every log line and every invitation mail an account sends, so the bound that reaches D1 and
 * the bound a caller is refused by have to be the same one.
 */
export async function renameOrganization(d1: D1Database, input: RenameOrganizationInput): Promise<void> {
  const name = Organization.shape.name.safeParse(input.name);
  if (!name.success) throw fromZodError(name.error);
  await changeOrganization(d1, input.organizationId, { name: name.data }, input.now ?? new Date());
}

/** What setting a mark needs. */
export interface SetLogoInput {
  /** Which account. */
  readonly organizationId: string;
  /**
   * The new mark, or **`null` to take it off**.
   *
   * Not optional, deliberately: removing a logo is an instruction somebody gives, and a shape that could
   * not express it would make the only way back uploading a blank image.
   */
  readonly logo: string | null;
  /** The clock. Also the version a served mark's URL carries, so a changed logo is a different URL. */
  readonly now?: Date;
}

/**
 * Set or clear the account's mark.
 *
 * **Through `@pithy-sh/core`'s `StoredImage`, which is the kit's one image rule** — the same value
 * `@pithy-sh/auth` reads for a person's face. There is no second allowlist here and there must not be
 * one: an account's mark and a person's face are the same object at different scales, and two answers to
 * *what may be stored as an image* is one of them being wrong. What that rule buys is in its own module,
 * and the short version is that the pattern is an allowlist of types rather than a check that the string
 * starts with `data:` — `data:text/html` is a `data:` URL too.
 */
export async function setLogo(d1: D1Database, input: SetLogoInput): Promise<void> {
  if (input.logo !== null) {
    const logo = StoredImage.safeParse(input.logo);
    if (!logo.success) throw fromZodError(logo.error);
  }
  await changeOrganization(d1, input.organizationId, { logo: input.logo }, input.now ?? new Date());
}

/**
 * Write one change to the account row, and refuse if it matched nothing.
 *
 * **The fields are named rather than spread.** `undefined` means *leave it alone* and `null` means *take
 * the mark off*, and a `set` built by spreading an input would collapse the two — writing `logo = NULL`
 * for a rename that never mentioned it.
 */
async function changeOrganization(
  d1: D1Database,
  organizationId: string,
  change: { name?: string; logo?: string | null },
  now: Date,
): Promise<void> {
  const set: { name?: string; logo?: string | null; updatedAt: number } = { updatedAt: now.getTime() };
  if (change.name !== undefined) set.name = change.name;
  if (change.logo !== undefined) set.logo = change.logo;

  const changed = await organizationDatabase(d1)
    .updateTable(ORGANIZATIONS_TABLE)
    .set(set)
    .where("id", "=", organizationId)
    .executeTakeFirst();

  // Nothing matched. The same 404 as everywhere — a caller who reached here without a membership learns
  // exactly what a caller naming an account that never existed learns, and the difference is in `detail`.
  if (changed.numUpdatedRows !== 1n) {
    throw new OrganizationNotFoundError({
      detail: `updating organization ${organizationId} matched ${changed.numUpdatedRows} rows`,
    });
  }
}

/**
 * Delete an organization, and everything that pointed at it.
 *
 * **Children first, in one batch.** D1 enforces no foreign keys, so referential integrity is held by the
 * writers — and a partial delete is the worst of the two outcomes: a membership naming an account that is
 * gone still answers *yes* to "is this person a member of `X`", and an acting row still points a live
 * session at it. One transaction means the account and every claim on it end together.
 *
 * The order mirrors the migration's `down`: the selections and the standing offer before the memberships
 * they name, the memberships before the organization. Within one transaction the order changes nothing,
 * and keeping it means the two places that tear this schema down read the same way.
 */
export async function deleteOrganization(d1: D1Database, organizationId: string): Promise<void> {
  const db = organizationDatabase(d1);

  // Asked first, so deleting an account that is not there refuses rather than reporting success for five
  // statements that changed nothing. A concurrent delete between this read and the batch loses the race
  // harmlessly: the second caller's statements match no rows, and the account is gone either way.
  const existing = await db
    .selectFrom(ORGANIZATIONS_TABLE)
    .select("id")
    .where("id", "=", organizationId)
    .executeTakeFirst();
  if (existing === undefined) {
    throw new OrganizationNotFoundError({ detail: `no organization row for ${organizationId}` });
  }

  await withD1Retry(() =>
    d1.batch([
      compile(d1, db.deleteFrom(ACTING_TABLE).where("organizationId", "=", organizationId)),
      compile(d1, db.deleteFrom(OWNERSHIP_NOMINATIONS_TABLE).where("organizationId", "=", organizationId)),
      compile(d1, db.deleteFrom(INVITATIONS_TABLE).where("organizationId", "=", organizationId)),
      compile(d1, db.deleteFrom(MEMBERSHIPS_TABLE).where("organizationId", "=", organizationId)),
      compile(d1, db.deleteFrom(ORGANIZATIONS_TABLE).where("id", "=", organizationId)),
    ]),
  );
}

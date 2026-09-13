# Scoping your own tables

_This capability answers *may this person act in this organization*. It does not, and cannot, answer *may they read this row of yours* — your tables are yours. This is the pattern that keeps the second answer honest, taken from the application this model was generalized from._

`requireOrganization()` proves a membership and puts it on `c.var.acting`. That is the first line. **This document is about the second**, and the second is the one that holds when a handler is refactored, a route is added by somebody who did not read the middleware, or an organization id arrives from a log line rather than from a resolved session.

## The rule

**Every query against a tenanted table of yours re-joins memberships, and takes the acting user as an argument it could technically do without.**

Not "filter by `organizationId`". By the time the query runs the caller has *usually* already been proved a member — and *usually* is the word doing the damage. A filter that exists only in middleware is a filter one merge away from not existing.

```ts
// Wrong, and it reads fine.
export async function listSessions(db: Db, organizationId: string) {
  return db.selectFrom("sessions").where("organizationId", "=", organizationId).execute();
}

// Right. The membership is in the statement, so there is no arrangement of callers that reaches
// another tenant's rows — including the caller that does not exist yet.
export async function listSessions(db: Db, lookup: { userId: string; organizationId: string }) {
  return db
    .selectFrom("sessions")
    .innerJoin("pithyOrganizationMemberships", (join) =>
      join
        .onRef("pithyOrganizationMemberships.organizationId", "=", "sessions.organizationId")
        .on("pithyOrganizationMemberships.userId", "=", lookup.userId),
    )
    .where("sessions.organizationId", "=", lookup.organizationId)
    .selectAll("sessions")
    .execute();
}
```

The extra argument is the point. A function that cannot be called without naming the acting user is a function nobody can accidentally call without one.

## Why it matters more the deeper the chain goes

The application this came from has a four-table chain: organization → project → environment → connection. That is **four places to drop the join back to memberships**, and only the first one is obvious. A connection is reached by an environment id, an environment by a project id, a project by an organization id — and at each hop it is tempting to trust the parent id the caller handed in, because a gate upstream proved *something*.

Every one of those functions re-joins memberships instead, and the tests walk each hop from the wrong organization. That last part is what makes the rule real rather than stated: **a test that reaches each level with a caller who belongs to a different account, and asserts nothing comes back.**

```ts
test("an environment id from another account resolves nothing", async () => {
  const theirs = await seedEnvironment(otherOrganization);
  expect(await readEnvironment(db, { userId: ADA, environmentId: theirs })).toBeUndefined();
});
```

## Refuse the same way this capability does

A row the caller may not see and a row that does not exist are one answer. A distinguishable refusal is an existence oracle, and iterating it enumerates the tenant's data — which is the same argument `docs/why-not-better-auth-organization.md` makes for organizations themselves, one level down. Throw `OrganizationNotFoundError` for both, and put the difference in `detail`, which the HTTP codec strips and the log keeps.

## What this capability does not do for you

It ships `requireOrganization()` and `requirePower()`. It has no view of your tables, so it cannot add the join for you, and a helper that tried would have to know your schema. What it can do is make the rule cheap to follow: `c.var.acting` already carries `{ organizationId, userId }`, which is exactly the pair every one of these queries needs, so passing it whole is less typing than passing the id alone.

## Deleting is the other half, and it is the half that bites later

Scoping a read keeps another tenant's rows away from this caller. It says nothing about what happens to *your* rows when the account they belong to is deleted — and this capability cannot answer that for you, because it has no view of your schema.

Without help it deletes its own five tables and stops. Yours stay, keyed to an organization that no longer exists. If what they hold is inert, that is untidy. If it is a credential, the act everybody believes revoked it did not.

So hand it the statements:

```ts
organization({
  roles,
  onDelete: (db, organizationId) => [
    db.deleteFrom("connections").where("organizationId", "=", organizationId),
    db.deleteFrom("environments").where("organizationId", "=", organizationId),
    db.deleteFrom("projects").where("organizationId", "=", organizationId),
  ],
})
```

**Statements, not work.** They join the same `d1.batch` as this capability's own deletes, so a failure anywhere rolls all of it back — the account and your rows end together or neither does. A function that deleted for itself could not be in that transaction, and what it would leave behind on a bad day is exactly the state this seam exists to prevent.

They run **before** the memberships go, so a statement may still resolve something through one.

**A foreign key is not the alternative.** D1 does enforce them — `pithy-sh/pithy#569` measured it — so the cascade you may be used to is real. It is real only while both tables are yours. Pointing one at `pithy_organization_organizations` binds your schema to this capability's release cadence and breaks the day either moves to its own database, which is the same boundary every other rule on this page is drawn around.

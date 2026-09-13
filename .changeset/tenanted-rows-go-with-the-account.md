---
"@pithy-sh/organization": minor
---

Deleting an organization now deletes your rows too, if you say which.

`deleteOrganization` swept its own five tables and stopped. Every adopter who composes this capability has tables keyed on `organizationId` — that is what tenancy is — and it cannot see them, so their rows stayed behind for an account that no longer existed. Where those rows hold a credential, the act everybody believes revoked it did not.

`organization({ onDelete })` takes a function returning statements, and they join the same `d1.batch`, ahead of this capability's own. **Statements rather than work**, because that is what puts them in the transaction: a failure anywhere rolls all of it back, so the account and your rows end together or neither does. A callback that deleted for itself could not be in that batch, and what it leaves behind on a bad day is the bug.

They run before the memberships go, so one may still resolve something through a membership.

A composition without `onDelete` behaves exactly as before.

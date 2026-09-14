---
"@pithy-sh/organization": minor
"@pithy-sh/core": minor
"@pithy-sh/cli": minor
---

Tenancy, out of the box.

Organizations, memberships, roles you define with the powers they hold, invitations bound to an address, ownership that moves only when somebody accepts it, and an acting selection proved against a live membership on every request. The model the Pithy dashboard itself runs on.

**You declare the roles**, because a coaching academy's `coach` and `student` are parallel where a dashboard's `owner`, `admin` and `member` nest — and a capability that assumed either shape would refuse the other. Nesting is asserted only where you claim it. Five power names are the kit's, because it ships the routes that gate on them; yours sit beside them under your own vocabulary, and your handlers import them as typed values rather than reading strings out of a config file. `pithy add organization` scaffolds the catalog and never overwrites one.

`administrativePower` is named rather than inferred from a role spelled `admin`, so an account with one owner and one admin does not become unadministrable when the admin leaves. Assignability is derived by exclusion, so a role you add is assignable by default and excluding it is the deliberate act.

**What a membership is worth is what makes the refusals load-bearing.** A caller naming an organization they do not belong to gets a 404 byte-identical to the one for an organization that does not exist, because a distinguishable refusal is an existence oracle and iterating it produces your customer list. A role is decoded off the row and refused when the catalog does not know it, never asserted against a matrix that would deny everything today and allow it after one refactor. Nothing about a role rides on the session — only the id of the chosen organization — so removing a membership row is the whole of revocation and takes effect on the next request with no sign-out.

The acting membership lands on its own context variable rather than on the auth one, because "signed in" and "a member of this organization" are two conditions and merging them makes them one. Composing this alongside Better Auth's `organization()` plugin is refused at boot, and `docs/why-not-better-auth-organization.md` is the record of why this model rather than that one — checked against `better-auth@1.7.1` line by line, including where the comparison has been stated wrongly before.

`@pithy-sh/core` gains a manifest-level `seams` field, for a capability that needs a scaffolded module under every configuration rather than under one choice of one option.

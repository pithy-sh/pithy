# Roles, powers, and the catalog you declare

_The reader's version of this page is [pithy.sh/docs/capabilities/organization/roles](https://pithy.sh/docs/capabilities/organization/roles). This copy ships in the package because a role name cannot be taken back once a membership holds one, and the rule has to be readable at the moment somebody writes the catalog._

Who may do what is declared once, by you, and read by every route. This page is where that claim is cashed: what the kit owns, what you own, what the database holds, and which of those three you can still change after somebody has joined.

## Three places, and they are different kinds of thing

**The capability owns five power names.** It ships routes — invite, change a role, remove a member, transfer ownership, delete the account — and those routes gate on something, so that something is the kit's and is closed.

**You declare your own powers and the whole matrix**, in `src/organization/roles.ts`, scaffolded by `pithy add organization` and never overwritten once it exists. A module rather than a config literal, because your own route code imports the typed powers and importing from `pithy.config.ts` into a handler is backwards. `defineRoles` is the house pattern — `defineErrorPayload`, `defineSecretRegistry`, `defineSupportCategories`.

**D1 holds the instances.** A membership's `role` column is a string from the declared set. Text, because the catalog is yours and is not known when the schema compiles.

The three move at different speeds, and that is the point. The kit's five are fixed by a release. Your matrix is a deploy. The instances are rows people are standing on.

## The five the kit reserves

| Power | What the capability's own routes gate on it |
| --- | --- |
| `organization:read` | Reading the organization, its roster, and a member's stored image |
| `organization:manage` | Renaming it, setting its mark, changing a role, removing somebody, and every invitation route |
| `organization:delete` | Ending the account, and everything belonging to it |
| `members:manage` | Handing somebody a role that administers — by invitation or by a role change |
| `billing:manage` | Offering ownership, and withdrawing the offer |

**Reserved, not merely taken.** Declaring one of these in your own `powers` is refused, naming it, on the same rule that reserves the kit's error domains: an adopter redeclaring one would be writing a second definition of a power this capability's own handlers already gate on, and the two definitions would then be kept in step by hand.

**Every one of them has to be held by some role.** A catalog in which nothing holds `organization:delete` describes an account that can never be ended, by anybody, ever — and the day somebody tries is a bad day to find out. So it is refused at boot, naming the power, because that is a catalog mistake rather than a runtime state.

`members:manage` is narrower than its name reads, and it is the one that surprises people. Running the roster day to day — inviting a reader, withdrawing an offer, removing somebody, demoting an administrator — is `organization:manage`. What `members:manage` gates is *minting another administrator*, and the reason is the escalation it closes: an administrator who could mint a second administrator could install a fourth party at their own level, and the two of them could then hand the account on between themselves.

## Two unrelated role sets have to coexist, and that is the whole design

A dashboard's `member`, `admin` and `owner` nest: every power a member holds an admin holds, and every power an admin holds an owner holds. A coaching academy's `coach` and `student` are parallel, and each holds what the other does not — a coach accepts sessions, a student requests them, and neither is a weaker version of the other.

**A kit that assumed nesting would refuse the academy outright.** Both catalogs are in the [README](../README.md), side by side, and neither is a degraded case of the other. The only thing they share is the five powers above.

## Nesting is asserted where it is declared, never assumed

`nests` lists roles weakest first, and `defineRoles` checks the claim: every power the weaker role holds, the stronger one must hold, or the catalog is refused naming both roles and every power that is missing.

Assert it where it is true. For a set where it does hold it is a real property worth holding, because it is what makes a promotion and a demotion mean something a person can predict — a demotion that granted a power the promotion had taken away is the one thing nesting rules out, and a catalog that merely *intended* to nest would allow exactly that.

It takes a chain, and it does not have to be every role. A catalog whose `admin` and `owner` nest above each other while `coach` and `student` sit beside both declares `["admin", "owner"]` and says nothing about the other two — which is the true claim, and a truer one than either silence or a four-name list that would be refused.

Omitting `nests` entirely is not a weaker catalog. It is a different shape of one.

## `administrativePower` is named, never inferred from a role spelled `admin`

It is required, it must be a power some role holds, and it is the thing the last-administrator invariant counts over.

Counting a role *name* gets this wrong in both directions. In the nesting catalog an owner holds `organization:manage` too, so an account with one owner and one admin does not become unadministrable when the admin goes — a floor that counted the word `admin` would refuse that removal for no reason. And a fourth role added later that carries the administrative power is governed by the invariant the day it is declared, without anybody remembering to come back and add it to a list.

**The last holder of `administrativePower` cannot be demoted, removed, or leave.** Three routes, one invariant, counted the same way in all three.

## Assignability is derived by exclusion

`unassignable` names the roles nobody may hand another person. Everything else is assignable.

Derived by exclusion rather than listed, so a role added to the catalog is assignable by default and *excluding* it is the deliberate act. The alternative fails the quiet way: a new role nobody can be given, discovered weeks later when somebody asks why the dropdown is short.

The dashboard excludes `owner`, and that exclusion is the whole of its ownership model. Ownership is who pays the bill and signs, so it is accepted rather than conferred: it moves only by a two-party transfer, and a newly founded organization therefore has none. The founder gets the first declared role that administers **and may be assigned** — being first is not owning.

**Handing somebody an administering role goes through one predicate, and both doors call it.** Offering a role in an invitation and promoting a member to it are the same act arriving by two routes. A rule checked in one of the two is a rule with a second door.

## A role is decoded, not asserted

The column is text. A repair script, a rolled-back deploy, a seed fixture or a bug can put anything in it, so every read parses the value through the catalog's own enum before anything is decided.

**A role matching no entry in the matrix would deny everything today and, one refactor later, allow it.** That is the failure being designed out: the deny is incidental — it falls out of a lookup missing — and nothing anywhere states it. Decoding makes an unrecognized value a refusal while there is still a request to refuse, and puts the junk value in `detail` where an operator can see it.

## What `defineRoles` refuses, and when

All of it at the moment the constant is written, because every one of these is a fact about the declaration and nothing about a request. There is no reason for the failure to wait for somebody to be refused by it.

| Refused | Because |
| --- | --- |
| A declared power colliding with one of the kit's five | Two definitions of a power the capability's own handlers gate on |
| A power declared twice | One name, one meaning |
| No roles at all | A membership has to hold something |
| A role holding a power nobody declared | A typo is a role quietly holding nothing, which is invisible until somebody is refused |
| An `administrativePower` that is not a declared power | The invariant would count over nothing |
| A kit power no role holds | A route this capability ships that nobody could ever use |
| An `administrativePower` no role holds | An account nobody could administer |
| A `nests` entry that is not a declared role | A claim about something that does not exist |
| A `nests` pair where the stronger role is short a power | The nesting is asserted, not documented |
| An `unassignable` entry that is not a declared role | Same |
| Every role excluded from assignment | Nobody could ever be given one |

One more is raised on the first founding rather than at boot: a catalog whose only administering roles are all excluded from assignment leaves nobody who could found an organization. `defineRoles` cannot know that this capability founds accounts, so the refusal lands where the fact is known — but it still names the catalog, not the request, because that is what is wrong.

## A role name is stable forever once a membership holds one

This is the rule to read twice.

Rows carry role names. Renaming `coach` to `instructor` does not migrate anybody: it orphans every membership holding the old name, and on the next request each of those people is decoded through a catalog that has never heard of their role and refused. **Nothing in this capability can repair that**, because nothing in this capability knows which new name an old one meant. Only you do, and only in a migration you write.

It is the same class of rule as two others the kit already holds, and for the same reason — a value recorded somewhere else, by somebody else, that a later edit cannot reach back and change.

**The project name.** Every Cloudflare resource name is recomputed from it on every command and stored nowhere, so a rename does not rename a database, it orphans it. The repository's `docs/NAMING.md` puts it plainly: once anything is provisioned, the project name is a contract.

**A `migrationOrder`.** Renumbering a released capability renames its composed ledger keys, which makes Kysely treat applied migrations as unapplied and re-run them. `packages/cli/src/migrations/orders.test.ts` calls it **stable forever** in those words.

A role name is the third. Adding a role is free, and so is changing what a role holds — the matrix is read fresh on every request and a demotion takes effect on the next one. **Renaming or deleting one is a data migration**, and the honest way to do it is to add the new role, move the rows, and only then take the old name out of the catalog.

So spell them the way you can live with. `admin` and `member` are names; `admin_v2` and `temp_role` are regrets.

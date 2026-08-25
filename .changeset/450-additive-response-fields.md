---
"@pithy-sh/email": patch
"@pithy-sh/auth": patch
---

Adding a field to an admin response no longer takes the pane away from everyone behind.

`EmailJobListItem.locale` and `AdminUserView.locale` landed as required keys — nullable, but required. For a project talking to its own Worker that costs nothing, because the two ship together. A management client is not that: it reads **other people's** Workers, each on whatever kit version it happens to be, and validates every response with the capability's own exported schema, which is the rule and the right one.

So an additive field is a hard break. A customer one release behind answers with no `locale` key, `safeParse` fails, and the whole pane refuses — on the day the *dashboard* deploys, rather than on any day that customer changed anything. A column nobody asked for costs them their send log.

Both are `.optional()` now, which leaves a reader the three states it genuinely has: a tag, `null` for *asked and never chose*, and absent for *this Worker cannot say*. Collapsing the last two would report every reader on an older Worker as having declined to pick a language.

**It relaxes the reader and never the producer.** A Worker on this release still projects the key; the tests hold both halves, so the fix cannot quietly become a removal of the feature.

The rule is now stated where someone adding a field is looking — in `CLAUDE.md` §HTTP and at the head of all eight `responses.ts` modules — and it is about these schemas rather than all of them, because a request schema has no version boundary to cross.

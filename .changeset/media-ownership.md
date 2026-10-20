---
"@pithy-sh/cli": minor
"@pithy-sh/cloudflare": minor
"@pithy-sh/core": minor
"@pithy-sh/i18n": minor
"@pithy-sh/media": minor
"@pithy-sh/organization": minor
"@pithy-sh/storage": minor
---

Media assets and stored objects now carry an owner, an organization and a visibility — private, organization or public — so a file is seen only by the people it is meant for, private media is delivered through signed URLs, usage rolls up per user or per team, duplicate detection stays inside the tenant, and an erasure reaches a subject's files. **Breaking:** existing media records become private and system-owned; the `kv` media record store is removed; storage's `defaultVisibility` is now `visibility.default`, and a config still naming the old key is refused; and a public file read from outside its organization, or anonymously, no longer names its `ownerId`.

Security: Four exposures, all live before this. Media's own routes checked only that a caller was signed in, so any user of an application could list, read and delete every other user's media in every organization, and every media delivery URL worked for anyone who held it. Duplicate detection was account-wide with no scope at all, so one tenant could ask whether another held a given file and a near-duplicate scan compared across every tenant's images. No read could be organization-scoped, so a per-user total summed across organizations and disclosed — by a figure that would not reconcile — that a user held an account in another organization. And nothing owned a media record, so a purge or a data-subject export could not enumerate a subject's files: an erasure would report success and leave them behind.

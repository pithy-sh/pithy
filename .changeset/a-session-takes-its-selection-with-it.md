---
"@pithy-sh/auth": minor
"@pithy-sh/organization": patch
---

A session ending now takes the acting selection with it.

`clearActing` existed, was exported, and **nothing called it** — so the acting selection outlived the credential that made it, one orphan row per sign-in, in a table with no TTL and no sweep. The capability's own schema says "signing out must take it with it"; there was no moment at which it could.

Nothing in `@pithy-sh/organization` can see a sign-out, and the dependency runs the wrong way to fix that there. So `@pithy-sh/auth` grows an `onSessionRevoked` seam, and the project composing both joins them:

```ts
auth({
  onSessionRevoked: async ({ id }, d1) => {
    await clearActing(organizationDatabase(d1), { sessionId: id });
  },
}),
```

**On the row, not on the sign-out route.** A sign-out, a revoke and an admin ending somebody's devices all delete the same row, so a listener hung off one endpoint would miss the others. It is handed this request's D1 binding because the auth instance is built per request, and it swallows what it throws — the session is already gone, and a listener's failure must not turn a completed sign-out into an error the caller retries.

Composing `@pithy-sh/auth` without a listener is unchanged and requires nothing.

The orphan row never conferred anything — every read re-joins memberships and matches the user id too — so this is growth rather than an access question.

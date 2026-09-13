---
"@pithy-sh/core": minor
"@pithy-sh/auth": minor
"@pithy-sh/cli": minor
---

Signing out of your app no longer destroys the dev login.

`pithy seed` used to mint a session row and the dev-login route handed that one row to a browser. A session is consumed by ordinary use, so the product's own sign-out revoked it — and from then on pressing `l` answered `404 No dev login has been seeded`, with a reseed in another terminal as the only way back in. Any sign-out did it, and testing sign-out is a normal thing to do while building a product that has one.

The seed now mints a signed **claim** naming the user, and the route exchanges it for a fresh session each time the link is opened. Sign-out revokes the session it should and leaves the way back in alone.

Three things follow from it. `pithy_auth_sessions` holds no row until somebody actually signs in, so a seeded session no longer appears in admin panes as a device nobody used. The fingerprint that made a stored token stale after a secret rotation is gone, because nothing is stored to go stale. And a rotation now invalidates the claim instead — reseed after one, which was already the expected move.

**Breaking: `logs/dev-login.json` changes shape.** `cookieName` and `cookieValue` are replaced by `claim`. Anything reading that file for a cookie must instead open `DEV_LOGIN_ROUTE` with the claim in the `t` parameter; `pithy dev` already does. Reseed once after upgrading — an artifact from an older release has no claim in it and is refused as unreadable rather than half-honoured.

The claim is a credential, and `pithy dev` keeps it out of the terminal on every run that can open a browser itself. A non-interactive run, or one with two workers composing auth, must print a link somebody clicks, so it prints one — `claimIsPrinted` in `dev/devLogin.ts` is where that boundary is stated and asserted.

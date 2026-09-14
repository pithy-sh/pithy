---
"@pithy-sh/core": minor
"@pithy-sh/auth": minor
---

Your users get a name and a face they chose.

`pithy_auth_users.image` held a link to whoever signed somebody in, written once and never again. So a page of twenty people was twenty requests to hosts the viewer did not choose, and somebody who signed in with GitHub was called whatever GitHub calls them, forever.

The column now takes a second shape: bytes, stored in your own D1 as a bounded `data:` URL. The provider link it already holds still works and existing rows are untouched.

The column was also unvalidated, and Better Auth's own `/update-user` passes `name` and `image` straight to the adapter — the `validator.input` mechanism reaches additional fields only, so a validator declared beside the column would have been a validator nothing ran. The rule now sits at the database hook, which every writer goes through: your route, Better Auth's, a social sign-in, an admin tool. `data:text/html` is a `data:` URL too, and that is the difference the allowlist exists to draw.

A sign-in is treated differently from a person's own edit, and the asymmetry is deliberate: a provider's over-long name is truncated and an avatar the kit will not hold becomes initials, because nobody should fail to sign in over a display name Google gave them. A person setting their own gets a 400 telling them what to send.

Rasters are served by URL from your own origin, versioned and `immutable`, so a roster costs one request per face once instead of its bytes on every read. **A vector never gets a URL and the route refuses to serve one** — an `<img src>` is inert by specification, but a URL is navigable and a navigated SVG runs script in the origin that served it. The attack is removed rather than managed with headers.

The whole rule — allowlist, ceiling, the derived byte figure, and the serving split — is one module in `@pithy-sh/core`, because `@pithy-sh/organization` holds an account's mark under the identical one and two answers to *what may be stored as an image* is one of them being wrong.

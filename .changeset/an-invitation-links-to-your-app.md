---
"@pithy-sh/organization": minor
---

An invitation email links to your app, not to this capability's JSON.

`invitationAcceptUrl` built the link from `basePath` — the prefix every route here mounts under — and `GET {basePath}/invitations/:token` answers `c.json(...)`. So every invitation this capability has ever sent pointed a person at a response body in their browser. Not a page, not an actionable error: the offer rendered as JSON.

No composition could avoid it. Aiming `basePath` at a page path does not help, because the JSON route mounts there too and the Worker answers before any client router sees the request.

`invitationAcceptPath` is now a setting of its own, `/invitations` by default, and the mail is built from it. The page you serve at `/invitations/:token` reads `GET {base}/invitations/:token` for the offer and posts the token to `POST {base}/invitations/accept` to redeem it — both unchanged.

**If you have already composed this capability**, check where your app serves that page. The default matches the conventional path; a project that mounted its acceptance screen elsewhere should set `invitationAcceptPath` to match, and pick it before inviting anybody, because changing it breaks the link in mail already sent.

`INVITATION_ACCEPT_SEGMENT` is renamed to `INVITATIONS_ROUTE_SEGMENT`. It names the JSON routes' segment inside `basePath` and no longer has anything to do with the accept link, and a constant still called *accept* would point the next reader at exactly the conflation this fixes.

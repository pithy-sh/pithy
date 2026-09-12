---
"@pithy-sh/auth": minor
---

Disconnecting a provider now requires a recent sign-in too.

Connecting one has since the last release. Disconnecting was left on Better Auth's own guard, which reads the age of your session row against a 24-hour default — a window nobody chose, and one that `/token/rotate` resets, so ordinary refreshing kept it open and anyone holding a stolen refresh token could reopen it at will.

Both directions now read the authentication instant a rotation carries forward, in one fifteen-minute window, and a refusal is recorded either way. A provider is never the last way in here, so detaching them all was the thing worth gating.

Security: stripping a connected provider now requires an authentication from the last fifteen minutes, measured so that a token rotation cannot reset it.

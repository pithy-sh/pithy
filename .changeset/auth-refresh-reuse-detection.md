---
"@pithy-sh/auth": minor
---

Refresh-token reuse detection. Each refresh chain carries a family id, preserved across rotations. Replaying a token that a rotation already consumed revokes the whole family and denies the request — the canonical hardening for rotated refresh tokens (RFC 6819). Rotation is now race-safe: one presented token yields exactly one successor. A denied `auth/token_reuse_detected` audit event records each caught replay.

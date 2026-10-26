---
"@pithy-sh/core": minor
"@pithy-sh/audit": minor
---

A management client can see which scopes each connection actually exercised, and which it was refused, without reading a single event in full.

Security: A verified connection refused for an ungranted scope was audited with no connection or key, so scope probing by a known credential could not be traced to it.

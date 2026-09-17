---
"@pithy-sh/cli": patch
"@pithy-sh/core": patch
---

A connection remembers which dashboard registered it. `status --verify`, `rotate` and `disconnect` built their client from `--origin` alone, so omitting the flag meant the hosted dashboard — and a connection registered against a self-hosted one was asked about at `app.pithy.sh`, which could not answer, and was reported as needing reconnection. The origin is recorded at connect and used by every later command; `--origin` still overrides and re-points the record, and a connection registered before the column falls back to its issuer. A management client that cannot be reached is now reported as `unreachable`, naming the address tried, rather than as a verdict on a connection nothing examined.

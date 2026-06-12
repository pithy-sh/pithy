---
"@pithy-sh/core": minor
---

Typed `db` and `kv` registries on the request context. Capabilities register D1 databases and KV namespaces; createBackend merges them per binding into typed accessors — `c.var.db.<database>` and `c.var.kv.<namespace>.<store>`. Multiple databases and namespaces coexist, composed from capability slices. No central schema file.

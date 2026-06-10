---
"@pithy-sh/core": minor
---

Typed KV access and the Kysely D1 database builder.

`TypedKv` — validated reads and writes over structured, namespaced keys: prefix-range `list`, size-bounded metadata (optionally derived from the value and self-healed when an external edit drops it), and partial-update `patch`. `createDatabase` — Kysely over D1 with the mandatory CamelCasePlugin, so camelCase queries map to snake_case columns.

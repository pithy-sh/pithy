---
"@pithy-sh/core": patch
"@pithy-sh/audit": patch
---

An audit event records which tenant it was for, not only which Worker wrote it.

`pithy_audit_events` stamped `project`, `environment`, and `worker` from the recording Worker's own vars. Those say which deployment of ours wrote a row, and in a multi-tenant application all three are identical on every row — so nothing on the event distinguished one customer's administrative history from another's, and an app composing audit could not read its own trail without leaking across tenants.

`actorId` was not that column. It answers *who*, not *for whom*, and the two part company the moment one person administers two accounts. Deriving the tenant afterwards from a membership table is wrong in both directions: joining tenant A today would hand you a year of tenant B's history, and leaving would take yours with you. The tenant of an action is a fact at the time of the action; membership is a fact now. So it is stamped on write.

`AuditEvent` gains `tenant`, and it is the one dimension the **emitter** supplies — the recorder can neither forge it nor default it, because no Worker var knows which customer an action was for. The field's own description says so, in contrast to the three the recorder stamps: it is exactly as trustworthy as the emit site. Optional and nullable, permanently: a single-tenant app must not be made to invent one, and `null` means *not tenant-scoped* rather than unknown.

`AuditQuery` gains the filter, including for null — `{ tenant: "org_7" }` is one customer's trail, `{ tenant: null }` is what was done outside any account, and omitting it filters nothing. Over HTTP the null filter is `?tenant=`, an empty value that no tenant id can collide with. The column is in the listing view as well as the detail one; a client that can filter by tenant but cannot see it has to take the filter on trust.

`0001_init` carries the column and a `(tenant, occurred_at)` index for the read this exists to serve, with a tested `down`. An event nobody states a tenant for reads as null, exactly as `project`/`environment`/`worker` already document, and nothing back-fills them.

Found building `pithy-sh/dashboard` on the kit: its "Our audit" pane could not be built without it, and every event recorded before it landed is permanently unattributable.

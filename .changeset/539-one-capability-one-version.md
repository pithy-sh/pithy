---
"@pithy-sh/cli": patch
---

`pithy doctor` reports two Workers holding different versions of one capability.

Capabilities are per Worker, so one can be installed at the project root or under `apps/<name>/node_modules`. With no root copy and two Workers each holding their own at different versions, resolution takes the first match in directory order — so `pithy payments provision` acting for `apps/api` builds its plan from api's manifest and loads admin's package, and exits 0.

A project's Workers should never be out of sync on a capability. The state is reachable all the same, nothing refuses it, and until now nothing said so.

The `capabilities:` section names each one, the Workers that disagree, and the version each resolves to — read from the resolved package's own manifest, never from a range, so the report names what would actually load. It does not fail the check: an unreachable capability does, because every `pithy <capability>` command for it refuses today, but skew refuses nothing and a hard failure would redden `doctor` for a project legitimately mid-upgrade with one Worker bumped ahead of another.

---
"@pithy-sh/cli": patch
---

`pithy doctor` and `pithy worker sync` read a binding's `scope` and `resource` from the same manifests `pithy provision` does, so a global binding such as email suppressions is no longer reported as drifted or made per-environment.

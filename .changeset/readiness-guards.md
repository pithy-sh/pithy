---
"@pithy-sh/core": minor
"@pithy-sh/vector": patch
---

A Worker in a bad state still answers its control plane. A capability declares a readiness guard, and the management surface is exempt from it, so `ping`, the manifest and other capabilities' admin routes keep answering on a Worker whose vector index has drifted. Every other route still refuses with a 500 `vector/metadata_index_drift`. Nothing reports the drift over the control plane yet.

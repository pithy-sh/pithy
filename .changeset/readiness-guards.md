---
"@pithy-sh/core": minor
"@pithy-sh/vector": patch
---

A Worker in a bad state still answers its control plane. A capability declares a readiness guard, and the management surface is exempt from it, so a misprovisioned index reports itself instead of hiding behind a 500.

---
"@pithy-sh/cli": patch
---

`pithy vector provision` waits up to ten minutes for a metadata index to go live, not five. Vectorize was measured taking longer than five.

---
"@pithy-sh/cli": patch
---

`pithy deploy` now gives a new version up to a minute to reach the declared domain, so a deploy that worked is no longer reported as a mismatch four seconds after the upload.

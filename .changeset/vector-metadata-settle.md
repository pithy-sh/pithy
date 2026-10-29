---
"@pithy-sh/cli": patch
"@pithy-sh/cloudflare": patch
---

`pithy vector provision` waits up to ten minutes for a metadata index to go live, not five, and a metadata index create that was retried after Cloudflare applied it no longer fails as a duplicate.

---
"@pithy-sh/cli": patch
---

Under a Cloudflare profile, Pithy reads the Secrets Store id and R2 keys from that profile's own file, never from `cloudflare.json`, and `pithy cloudflare connect` records the store id for you.

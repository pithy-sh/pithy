---
"@pithy-sh/core": minor
"@pithy-sh/auth": minor
"@pithy-sh/support": minor
"@pithy-sh/organization": minor
"@pithy-sh/email": patch
"@pithy-sh/cli": minor
---

Searching the users or the support inbox, and the reason an operator gives for a user export or an invitation listing, now travel in a POST body, never a URL, so nothing a person types lands in a request log. The user listing refuses the old `?search=`, and the GET forms of the inbox search, the export and the invitation listing are gone. Run `pithy dashboard connect` from this CLI or newer: an older one reads the new POST reads as writes and leaves their scopes out of the default grant.

Security: A search term typed into the users or support search on the control plane, often a person's email address, and the free-text reason given for a user export or an invitation listing, were written to the customer's request logs, Workers observability and any proxy in between as query parameters.

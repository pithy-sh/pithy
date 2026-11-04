---
"@pithy-sh/core": minor
"@pithy-sh/email": minor
"@pithy-sh/cli": patch
---

Looking up one address on the suppression list, or the connections one person authorized, is now a POST with the address in the body, so it never lands in a request log. The listings now refuse the old `?email=` and `?principal=`.

Security: An email address looked up through `GET /email/suppressions?email=`, or a principal through `GET /control-plane/connections?principal=`, was written to the customer's request logs, Workers observability and any proxy in between as a query parameter.

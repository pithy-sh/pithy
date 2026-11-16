---
"@pithy-sh/organization": minor
"@pithy-sh/core": minor
"@pithy-sh/auth": minor
---

An owner's `DELETE /current` shuts the organization and runs the purge Workflow, so every capability's organization purge runs and the deletion is recorded.

Security: An owner's delete erased only the organization's own rows: other capabilities' organization data, such as stored files, was left behind, and no erasure record was written.

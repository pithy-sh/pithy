---
"@pithy-sh/multiplayer": patch
---

A session reads only for its members. `GET /multiplayer/sessions/:id` and its `/result` refuse anyone else with 403, as the socket already does.

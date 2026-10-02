---
"@pithy-sh/cli": minor
---

`pithy dev` now pins a live worker roster beneath its output — each worker's state, port and timing, with keys to restart, open, sign into or show the logs of one, and a row for the workers this branch has parked. Worker output is hidden until asked for, and a worker that fails reveals itself. `l` reads the seeded identities as it is pressed and offers them in a picker, so a `pithy seed` run mid-session is picked up.

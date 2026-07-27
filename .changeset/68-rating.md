---
"@pithy-sh/rating": minor
---

Rate your players. A per-player store of two numbers per pool: a skill rating (MMR) that moves up and down with each result and feeds matchmaking, and an experience total (XP) that only ever rises and drives rank. The algorithm is pluggable — `elo`, `glicko` (Glicko-2), and `trueskill` ship built in, each declaring the player counts it supports; wiring a 1v1-only algorithm to an N-player game fails at assembly.

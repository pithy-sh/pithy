# Choosing a rating algorithm

The rating tracker holds two numbers per player per pool. Skill rating (MMR) is the matchmaking input — it moves up and down with each result, weighted by opponent strength, and can be hidden from players. Experience (XP) is the visible progression — a monotonic total that only ever rises and drives rank and level. This document is about the first number: which algorithm computes it.

Three algorithms ship behind one seam. Each declares the player counts it supports, and the tracker rejects at assembly a game that wires a 1v1-only algorithm to an N-player game — the same way a bad game config fails on deploy rather than at 3am. You choose one per game and set its pool; you can register your own with `registerRatingAlgorithm`.

## The one-line answer

Rating a 1v1 game and you want it simple and transparent? Use `elo`. Rating a 1v1 game where players play infrequently and you care about rating accuracy? Use `glicko`. Rating anything else — free-for-alls, teams, any count above two? Use `trueskill`. It is the only built-in that fits this package's N-player games.

## `elo`

One number per player, and nothing else. A win moves both players by `K × (actual − expected)`, where the expected score comes from the rating gap. Beating a stronger player earns more than beating a weaker one; that is the whole model. `K` (the K-factor, default 32) is the single dial — larger `K` reacts faster and swings harder, smaller `K` is steadier.

Elo is 1v1 only. It has no notion of uncertainty, so a brand-new player and a veteran with a thousand games are treated identically at the same rating — the new player's number just takes many games to find its level. Reach for Elo when you want a rating players can understand at a glance and you do not need fast convergence.

Supports: 2 players. Skill number: the rating itself.

## `glicko` (Glicko-2)

Elo's successor, and still 1v1. Alongside the rating it tracks a rating deviation (RD) — how confident the system is — and a volatility — how erratic the player's recent results have been. A result from a high-RD player moves their rating a lot and their opponent's a little; RD shrinks as they play and grows back while they are idle. That is why Glicko re-converges fast for infrequent players: a returning player is treated as uncertain and finds their level in a handful of games rather than dozens.

The volatility is solved each game by an iteration (the crux of Glicko-2) and is constrained by the system constant `τ` (default 0.5) — smaller `τ` damps volatility swings. The skill number this tracker exposes and buckets on is `rating − 2·RD`, a conservative estimate that treats an uncertain player as weaker until they have proven otherwise, which keeps new and returning players out of lopsided matches.

Supports: 2 players. Skill number: `rating − 2·RD`.

## `trueskill`

The Bayesian one, and the only built-in that rates more than two players. Each player is a Gaussian belief — a mean skill `μ` and an uncertainty `σ`. A game is evidence that shifts every participant's belief: winners' `μ` rises, losers' falls, and everyone's `σ` shrinks toward certainty. It handles 1v1, N-player free-for-alls (each player is a team of one), and teams (a team's skill is the sum of its members', and the result is distributed back across them).

Matchmaking buckets on `μ − 3·σ`, a conservative rank that stays low until the system is confident. Constants: `β` (skill class width, default `σ0/2`) sets how much a single game can prove, `τ` (dynamics, default `σ0/100`) lets ratings drift over time so a long-dormant player is not frozen, and the draw probability shapes how a tie is interpreted. This built-in uses the standard sequential approximation for more than two teams — see the source for the exact method.

Supports: 2 or more players; teams. Skill number: `μ − 3·σ`.

## Pools

An algorithm rates a pool, not a game directly. A pool is a named bucket of ratings; a game reads and writes one. Point several games at one pool (`global`) for a single cross-game rating, or give each game its own pool (the default — the pool defaults to the game key) for independent ladders. A pool is rated by a single algorithm; matchmaking buckets on the configured pool's skill number.

## Registering your own

The seam is `RatingAlgorithm` (`@pithy-sh/rating/src/algorithm/algorithm`): declare an `id`, a `params` schema with defaults, a `state` schema, the player counts you support, and pure `initial` / `update` / `skill` functions. Register it with `registerRatingAlgorithm` before the capability assembles, then name its `id` in a game. The tracker validates your params and player bounds exactly as it does the built-ins.

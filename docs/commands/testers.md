# pithy testers

Runs a closed test from the terminal: create a cohort, invite people, see where they stand, chase whoever needs chasing, and deploy the daily pass that does it on a schedule.

**The dashboard is the paid tier; this is not.** Every operation the control-plane routes expose has a command here, each non-interactive and each with `--json`.

## Synopsis

```
pithy testers provision [--env <env>] [--json]
pithy testers deprovision [--env <env>] [--json]
pithy testers create <name> [--env <env>] [--target-size <n>] [--window-days <n>] [--max-roster <n>] [--platform <android|ios>] [--store-url <url>] [--json]
pithy testers list [--env <env>] [--json]
pithy testers invite <cohort> --email <address> [--email <address>…] [--name <name>] [--env <env>] [--json]
pithy testers pending <cohort> [--env <env>] [--json]
pithy testers roster <cohort> [--env <env>] [--json]
pithy testers status <cohort> [--env <env>] [--trend-days <n>] [--json]
pithy testers remove <cohort> --email <address> [--reason <text>] [--env <env>] [--json]
pithy testers close <cohort> [--env <env>] [--json]
pithy testers run [--cohort <cohort>] [--env <env>] [--skip-nudges] [--json]
```

**Which operations need a Cloudflare account.** `provision` and `deprovision` always do — they deploy and delete a Worker. The nine roster subcommands read and write the database directly, so at the default `--env dev` they run entirely locally, resolving through Miniflare against the same `.wrangler/state` `pithy dev` uses. Point any of them at `staging` or `prod` and they resolve over the REST client keyed by that environment's `wrangler.jsonc` ids, which needs credentials.

**The roster commands talk to the database, not to the Worker over HTTP.** The control-plane routes exist for a management client holding a credential; a developer at a terminal in their own repo already has the database, and minting a token to read their own roster would be ceremony with no security benefit.

**Every opt-in figure here is Pithy's estimate from your own invite records.** Google's count is authoritative and no API exposes it. The human-readable status outputs close with that sentence; the `--json` cohort views carry it as a required `disclaimer` object.

## Flags

`--env` is two different sets, deliberately. The roster subcommands default to `dev` and accept `dev`, `staging`, or `prod`, because they talk to a local D1 and dev is where you use them. `provision` and `deprovision` deploy a Worker to a Cloudflare account, where there is no dev to deploy to, so they take a **managed** environment only — `staging` or `prod` — and omitting the flag means every one.

`pithy testers provision` / `pithy testers deprovision`

| Flag | Default | Purpose |
|---|---|---|
| `--env <env>` | every managed environment | Act on one environment only: `staging` or `prod`. `--env dev` is refused with the reason |
| `--json` | `false` | Machine-readable output — one line, one object |

`pithy testers create <name>`

| Flag | Default | Purpose |
|---|---|---|
| `<name>` | — | **Required positional.** A label for the cohort, e.g. `closed-test` |
| `--env <env>` | `dev` | Target environment |
| `--target-size <n>` | the capability's `cohortDefaults.targetSize` (12, Play's floor) | Testers required simultaneously |
| `--window-days <n>` | `cohortDefaults.windowDays` (14, Play's window) | Continuous days required |
| `--max-roster <n>` | `cohortDefaults.maxRosterSize` (100) | Roster cap |
| `--platform <android\|ios>` | `cohortDefaults.targetPlatform` (`android`) | Which store's program this cohort serves |
| `--store-url <url>` | `cohortDefaults.storeOptInUrl` | The store's own opt-in link, e.g. `https://play.google.com/apps/testing/<package>` |
| `--json` | `false` | Machine-readable output |

The three numeric flags must each be a whole number above zero, and `--platform` must be one of the two. Both are checked at the flag rather than at the schema, so the answer names what you typed.

`pithy testers list`

| Flag | Default | Purpose |
|---|---|---|
| `--env <env>` | `dev` | Target environment |
| `--json` | `false` | Machine-readable output |

`pithy testers invite <cohort>`

| Flag | Default | Purpose |
|---|---|---|
| `<cohort>` | — | **Required positional.** The cohort name or id |
| `--email <address>` | — | **Required.** Address to invite. Repeat the flag for several |
| `--name <name>` | — | A display name for the roster, applied to every address in this run |
| `--env <env>` | `dev` | Target environment |
| `--json` | `false` | Machine-readable output |

`invite` adds people to the roster and sends nothing. `pithy testers run` is what asks them whether they will test.

`pithy testers pending <cohort>` / `pithy testers roster <cohort>` / `pithy testers close <cohort>`

| Flag | Default | Purpose |
|---|---|---|
| `<cohort>` | — | **Required positional.** The cohort name or id |
| `--env <env>` | `dev` | Target environment |
| `--json` | `false` | Machine-readable output |

`pithy testers status <cohort>`

| Flag | Default | Purpose |
|---|---|---|
| `<cohort>` | — | **Required positional.** The cohort name or id |
| `--env <env>` | `dev` | Target environment |
| `--trend-days <n>` | `30` | How many daily snapshots to include in `trend.series` |
| `--json` | `false` | Machine-readable output |

`pithy testers remove <cohort>`

| Flag | Default | Purpose |
|---|---|---|
| `<cohort>` | — | **Required positional.** The cohort name or id |
| `--email <address>` | — | **Required.** The tester's address |
| `--reason <text>` | — | A short note recorded on the event |
| `--env <env>` | `dev` | Target environment |
| `--json` | `false` | Machine-readable output |

`pithy testers run`

| Flag | Default | Purpose |
|---|---|---|
| `--cohort <cohort>` | every open cohort | Run one cohort only, by name or id |
| `--env <env>` | `dev` | Target environment |
| `--skip-nudges` | `false` | Advance state and record the day, but send nothing |
| `--json` | `false` | Machine-readable output |

## What it does

**`provision`** deploys the daily-pass Workflow worker — `<project>-<env>-testers-daily` — for each requested environment and then writes its `TESTERS_DAILY` Workflow binding into the project's `wrangler.jsonc`. `pithy add testers` cannot write that binding: wrangler requires both a `name` and a `class_name` on every `workflows` entry, and the deployed name is per environment, so `add` emits none and this run completes it. Preflight runs once before the first deploy, so failing means failing before one environment is half provisioned.

Each environment's deploy resolves two ids first: the app `DB` id from that environment's stanza in the project's `wrangler.jsonc`, and this project's shared email-suppression database, looked up by name — the daily pass reads it to reconcile bounced addresses, so `pithy email provision` has to have run.

The sending identity is read off the composed `email` capability rather than asked for. When no email capability is composed, the host is still deployed and the pass records the day but sends nothing — said at provision time rather than discovered on the first silent morning. The pass runs daily at 05:00 UTC.

**`deprovision`** deletes the host and nothing else. The cohorts, the roster, and the whole snapshot series are rows in your own D1 and are not this command's to remove.

**`create`** creates a cohort, freezing the target, window, roster cap, platform, and reset policy onto the row. They are stored rather than read from config at query time: raising `targetSize` from twelve to fifteen later would otherwise retroactively rewrite whether last Tuesday counted.

**`list`** reads every cohort with its clock. **`roster`** reads the full roster with per-tester activity and health. **`status`** reads the clock, the observed activity, the forecast, and the trend, over the last `--trend-days` snapshots. All three degrade rather than fail when the activity read cannot run — auth tables absent, or a transient D1 error — and say so on stderr at `warn`, which shows without `--debug` and leaves the `--json` contract on stdout untouched. Without that line a whole roster reading "never signed in" is indistinguishable from a cohort nobody ever used.

**`invite`** adds addresses to the roster, refusing one already on it in a live state rather than quietly resetting the date the streak is measured from. A previously removed member is revived, keeping their id so their history stays attached to one person. A tester who withdrew is not revived at all.

**`pending`** prints the addresses that have agreed to test and are waiting to be added to the store's own tester list. This is the one step Pithy cannot do for you: the Play Developer API has no way to add an address to an email list, so you paste these into the console. Until that is done the store link answers `App not available`, which is why the second email waits.

**`remove`** takes a tester off the roster. **`close`** closes a cohort: its roster and trend stay readable, and nothing further is sent.

**`run`** runs the daily pass now — advance state, chase whoever is due, record the day. Sends are real: `enqueueEmail` writes a row into `pithy_email_jobs` and the email worker that already exists for any project using auth delivers it, so the CLI needs no sending domain of its own. The row stays `pending` until that worker's every-minute scheduler picks it up, which costs up to a minute and loses nothing. With `--skip-nudges`, or with no email capability composed, state still advances and the day is still recorded.

## `--json`

One line, one object. The `command` field is the space-separated subcommand name.

### `pithy testers provision`

| key | type | meaning |
|---|---|---|
| `command` | `"testers provision"` | The subcommand that produced this line |
| `results` | array | One entry per environment provisioned |
| `results[].env` | `"staging" \| "prod"` | The environment this entry describes |
| `results[].worker` | string | The deployed daily-pass worker name, `<project>-<env>-testers` |
| `sends` | boolean | Whether an email capability is composed. `false` means the pass will record the day and send nothing |

### `pithy testers deprovision`

| key | type | meaning |
|---|---|---|
| `command` | `"testers deprovision"` | The subcommand that produced this line |
| `results` | array | One entry per environment torn down |
| `results[].env` | `"staging" \| "prod"` | The environment this entry describes |
| `results[].worker` | string | The daily-pass worker name that was deleted. Absent is success — teardown is idempotent |

### `pithy testers create` and `pithy testers close`

Both emit the whole cohort row, under the same key and the same shape. `create` returns it as created; `close` returns it as the close left it.

| key | type | meaning |
|---|---|---|
| `command` | `"testers create"` \| `"testers close"` | The subcommand that produced this line |
| `cohort` | object | The cohort row |
| `cohort.id` | string | The cohort's UUID. Text rather than a sequential id, which would leak how many test programs a project has run |
| `cohort.name` | string | The human label |
| `cohort.targetPlatform` | `"android" \| "ios"` | Which store's program this cohort serves |
| `cohort.targetSize` | integer | How many testers must be opted in simultaneously. Frozen on the row |
| `cohort.windowDays` | integer | How many continuous days the target must hold. Frozen on the row |
| `cohort.maxRosterSize` | integer | The most members this roster may hold |
| `cohort.storeOptInUrl` | string \| null | The store's own opt-in page. `null` until set — and until it is, nobody can actually join the test |
| `cohort.resetPolicy` | `"reset" \| "pause"` | Pithy's assumption about what a dip below target does to the streak. Google documents neither behavior |
| `cohort.closedAt` | ISO-8601 string \| null | When the cohort was closed, or `null` while it runs |
| `cohort.createdAt` | ISO-8601 string | When the cohort was created. The zero point of its `dayIndex` axis |
| `cohort.updatedAt` | ISO-8601 string | When the row was last written |

### `pithy testers list`

| key | type | meaning |
|---|---|---|
| `command` | `"testers list"` | The subcommand that produced this line |
| `cohorts` | array | Every cohort, newest first |
| `cohorts[].id` | string | The cohort id |
| `cohorts[].name` | string | The cohort's human label |
| `cohorts[].estimatedOptedIn` | integer | Pithy's estimate of the currently opted-in count |
| `cohorts[].targetSize` | integer | The target in force for this cohort |
| `cohorts[].estimatedHeldDays` | integer | The estimated unbroken at-target run ending today |
| `cohorts[].windowDays` | integer | Continuous days the program requires |
| `cohorts[].closed` | boolean | Whether the cohort has been closed |

### `pithy testers invite`

| key | type | meaning |
|---|---|---|
| `command` | `"testers invite"` | The subcommand that produced this line |
| `cohort` | string | The resolved cohort **id**, whether you passed a name or an id |
| `invited` | array | One entry per `--email`, in the order given |
| `invited[].id` | string | The member id. Stable across a revival, so history stays attached to one person |
| `invited[].email` | string | The invited address, normalized |
| `invited[].created` | boolean | `false` when the row already existed and was revived. Re-inviting is not an error, so this is how the two are told apart |

### `pithy testers pending`

| key | type | meaning |
|---|---|---|
| `command` | `"testers pending"` | The subcommand that produced this line |
| `cohort` | string | The resolved cohort id |
| `emails` | array of string | Every tester in the `accepted` state — they have agreed to test and are waiting to be added to the store's tester list |

### `pithy testers remove`

| key | type | meaning |
|---|---|---|
| `command` | `"testers remove"` | The subcommand that produced this line |
| `member` | object | The removed tester |
| `member.id` | string | Their member id |
| `member.email` | string | Their address |

### `pithy testers run`

| key | type | meaning |
|---|---|---|
| `command` | `"testers run"` | The subcommand that produced this line |
| `results` | array | One entry per cohort the pass ran for — one with `--cohort`, otherwise every open cohort |
| `results[].cohortId` | string | The cohort this entry describes |
| `results[].snapshotOn` | string | The UTC day the pass recorded, `YYYY-MM-DD` |
| `results[].nudged` | object | Nudges enqueued by kind. Enqueued, not delivered — that is the email worker's job |
| `results[].nudged.confirm` | integer | Will-you-test nudges |
| `results[].nudged.store` | integer | Store-link nudges — the only kind that can move the opt-in count |
| `results[].nudged.inactive` | integer | Inactivity nudges |
| `results[].nudged.closing` | integer | Window-closing nudges |
| `results[].estimatedOptedInCount` | integer | Pithy's estimate of the opted-in count after the pass |
| `results[].estimatedHeldDays` | integer | The estimated unbroken at-target run ending on this day |
| `results[].trendDirection` | `"improving" \| "steady" \| "declining" \| "unknown"` | The direction as of this pass |
| `results[].pruned` | integer | Snapshots pruned by the retention policy in this pass |
| `results[].nudgesSkipped` | `"no_base_url"` | Why nothing was sent, when nothing was sent for a reason worth reporting — sending was on and no link could be built. **Absent from the line** otherwise, including under `--skip-nudges`. A pass that mailed nobody because it could not build a link looks identical to a pass where nobody was due, and those are very different states to be in on day 9 |

### `pithy testers roster` and `pithy testers status`

Both emit one cohort view under `cohort`, and the view is the same shape the control plane serves a dashboard. The two differ in exactly two ways: `roster` includes `cohort.members` and loads no snapshots; `status` omits `cohort.members` entirely and loads the last `--trend-days` of them.

That difference reaches `cohort.trend`. `direction` and every delta come off the most recent stored snapshot, so under `roster` — which loads none — `direction` is `"unknown"`, `reason` is `Not enough history yet.`, the four deltas are `null`, and `series` is empty. Read the trend from `status`. `fragile` is the one field that still answers under `roster`: with no snapshot to read it is computed live from the clock.

| key | type | meaning |
|---|---|---|
| `command` | `"testers roster"` \| `"testers status"` | The subcommand that produced this line |
| `cohort` | object | The cohort view |
| `cohort.id` | string | The cohort id |
| `cohort.name` | string | The cohort's human label |
| `cohort.targetPlatform` | `"android" \| "ios"` | Which store's program this cohort serves |
| `cohort.targetSize` | integer | Testers required simultaneously |
| `cohort.windowDays` | integer | Continuous days required |
| `cohort.maxRosterSize` | integer | The cohort's roster cap |
| `cohort.resetPolicy` | `"reset" \| "pause"` | Pithy's assumption about what a dip below target does to the streak |
| `cohort.createdAt` | ISO-8601 string | When the cohort was created |
| `cohort.closedAt` | ISO-8601 string \| null | When it was closed, or `null` while running |

**`cohort.roster`** — current composition.

| key | type | meaning |
|---|---|---|
| `cohort.roster.size` | integer | Members on the roster, in every state |
| `cohort.roster.headroomToMax` | integer | How many more may be added before the cap. Counted against live states only, so a lapsed member does not occupy a slot |
| `cohort.roster.invited` | integer | Invited, and have not yet answered |
| `cohort.roster.accepted` | integer | Have agreed to test, and are waiting for the store link |
| `cohort.roster.optedIn` | integer | Pithy's estimate of currently opted-in testers |
| `cohort.roster.lapsed` | integer | Opted out or removed |
| `cohort.roster.unreachable` | integer | Bounced or suppressed — we cannot nudge them |
| `cohort.roster.neverLinked` | integer | Confirmed but never signed in. Counted toward the target; invisible to activity |

**`cohort.estimatedClock`** — Pithy's estimate, named `estimated*` field by field so it cannot be mistaken for Google's.

| key | type | meaning |
|---|---|---|
| `cohort.estimatedClock.source` | `"pithy_estimate"` | The literal discriminator. This block is replayed from our own invite records |
| `cohort.estimatedClock.meetsTarget` | boolean | Whether the estimated opted-in count is at or above target right now |
| `cohort.estimatedClock.headroom` | integer | Estimated count minus target. Zero means one lapse from a reset; it can go negative |
| `cohort.estimatedClock.estimatedHeldDays` | integer | The estimated unbroken at-target run ending today |
| `cohort.estimatedClock.estimatedDaysRemaining` | integer | Days still to hold, on Pithy's estimate |
| `cohort.estimatedClock.estimatedWindowStartOn` | string \| null | The UTC day the current run began, `YYYY-MM-DD`, or `null` while below target |
| `cohort.estimatedClock.resetCount` | integer | How many times the run has broken since the cohort started |
| `cohort.estimatedClock.dayBoundary` | `"UTC"` | Pithy counts days in UTC. Google's boundary is undocumented and may differ |

**`cohort.activity`** — the observed half, read from the auth tables.

| key | type | meaning |
|---|---|---|
| `cohort.activity.source` | `"observed"` | The literal discriminator. This block is fact, not estimate |
| `cohort.activity.active` | integer | Authenticated inside the active window |
| `cohort.activity.darkThreeToSeven` | integer | Quiet 3–7 days |
| `cohort.activity.darkEightToThirteen` | integer | Quiet 8–13 days — the strongest silent-uninstall signal |
| `cohort.activity.darkFourteenPlus` | integer | Quiet 14 days or more |
| `cohort.activity.neverLinked` | integer | No activity data exists for these testers at all |
| `cohort.activity.observedCoverage` | number 0–1 | Share of opted-in testers with any activity signal |

**`cohort.projection`** — Pithy's forecast. Every field is an estimate; none of it reads Google.

| key | type | meaning |
|---|---|---|
| `cohort.projection.basis` | `"estimated" \| "target_met" \| "insufficient_pipeline" \| "no_observable_signal" \| "no_history"` | Why the forecast reads as it does, and why any null here is null |
| `cohort.projection.calibration` | `"default"` | Says out loud that the survival priors are numbers Pithy chose, not values fitted to your data |
| `cohort.projection.method` | `"poisson_binomial_v1"` | The named, versioned method. A chart must not splice two methods into one line |
| `cohort.projection.confidence` | `"low" \| "moderate" \| "high"` \| null | `null` when nothing is observable at all — no opinion, rather than a weak one |
| `cohort.projection.observedCoverage` | number 0–1 | Share of opted-in testers we can see. The honest denominator behind every number here |
| `cohort.projection.probabilityReachTarget` | number 0–1 | Chance of reaching the target at all. One when already there |
| `cohort.projection.probabilityHoldWindow` | number 0–1 \| null | Chance at least `targetSize` testers hold for the remaining days |
| `cohort.projection.successProbability` | number 0–0.99 \| null | Pithy's estimate of completing the window. Capped below one, and `null` rather than a plausible-looking guess |
| `cohort.projection.successProbabilityRange` | object \| null | The band, which widens exactly in proportion to how blind Pithy is. Render the band, not the point |
| `cohort.projection.successProbabilityRange.low` | number 0–1 | The pessimistic bound, treating every unobservable tester as fragile |
| `cohort.projection.successProbabilityRange.high` | number 0–1 | The optimistic bound, treating every unobservable tester as solid |
| `cohort.projection.expectedSurvivors` | number | How many testers we expect to still be opted in when the window closes |
| `cohort.projection.projectedTargetMetOn` | string \| null | Projected UTC day the cohort first reaches target |
| `cohort.projection.projectedCompleteOn` | string \| null | Projected UTC day the window completes, on Pithy's estimate |
| `cohort.projection.invitesNeeded` | integer | How many more people to invite at this cohort's own conversion rate. Usually worth more than the probability beside it |
| `cohort.projection.recommendedRosterSize` | integer | The roster size that survives the window at this cohort's own conversion and drop-off rates |

**`cohort.trend`** — direction of travel, and the series behind it.

| key | type | meaning |
|---|---|---|
| `cohort.trend.direction` | `"improving" \| "steady" \| "declining" \| "unknown"` | By a published rule, not a fit. `unknown` until three snapshots exist |
| `cohort.trend.reason` | string | One sentence explaining the direction |
| `cohort.trend.fragile` | boolean | At target, no headroom, and at least one weak tester: one lapse from a reset |
| `cohort.trend.optedInDelta1d` | integer \| null | Opt-in change since yesterday. `null` without a prior snapshot |
| `cohort.trend.optedInDelta7d` | integer \| null | Opt-in change over seven days |
| `cohort.trend.activeDelta7d` | integer \| null | Active-count change over seven days — engagement's direction |
| `cohort.trend.successProbabilityDelta7d` | number \| null | Forecast change over seven days. The trend rule's primary input |
| `cohort.trend.series` | array | Trailing daily snapshots, oldest first. Filled by `status`; empty under `roster` |

Each entry of `cohort.trend.series` is one day of the cohort's position as it was believed on that day:

| key | type | meaning |
|---|---|---|
| `…series[].snapshotOn` | string | The UTC day this point covers, `YYYY-MM-DD` |
| `…series[].dayIndex` | integer | Days since the cohort was created — a zero-based x-axis so cohorts can be overlaid |
| `…series[].backfilled` | boolean | Written after its day had passed. Render dashed: the activity figures were reconstructed, not measured |
| `…series[].modelVersion` | string | The constant set behind this point's forecast. Annotate the chart where it changes |
| `…series[].rosterSize` | integer | Members on the roster that day |
| `…series[].invitedCount` | integer | Invited, and had not yet answered |
| `…series[].acceptedCount` | integer | Had agreed to test, waiting for the store link |
| `…series[].estimatedOptedInCount` | integer | Pithy's estimate of the opted-in count that day |
| `…series[].lapsedCount` | integer | Opted out or removed |
| `…series[].targetSize` | integer | The target in force that day |
| `…series[].meetsTarget` | boolean | Whether the estimate reached the target that day |
| `…series[].headroom` | integer | Estimated count minus target. Zero is the danger line; it can go negative |
| `…series[].estimatedHeldDays` | integer | The estimated unbroken at-target run ending that day |
| `…series[].estimatedDaysRemaining` | integer | Window days still to hold, on Pithy's estimate |
| `…series[].resetToday` | boolean | Whether the run broke that day — the single most important annotation on the chart |
| `…series[].resetCount` | integer | How many times the run had broken by that day |
| `…series[].activeCount` | integer | Observed testers who authenticated inside the active window |
| `…series[].darkThreeToSevenCount` | integer | Observed testers quiet 3–7 days. The first leading indicator |
| `…series[].darkEightToThirteenCount` | integer | Observed testers quiet 8–13 days |
| `…series[].darkFourteenPlusCount` | integer | Observed testers quiet 14 days or more |
| `…series[].neverLinkedCount` | integer | Opted-in testers who never signed in |
| `…series[].observedCoverage` | number | Share of opted-in testers visible that day |
| `…series[].medianHealth` | integer \| null | Median health across observed testers |
| `…series[].minHealth` | integer \| null | The weakest observed tester. A cohort breaks at its weakest link |
| `…series[].successProbability` | number \| null | Pithy's estimate of completing the window, as of that day |
| `…series[].successProbabilityLow` | number \| null | The pessimistic bound that day |
| `…series[].successProbabilityHigh` | number \| null | The optimistic bound that day |
| `…series[].expectedSurvivors` | number | Expected survivors as of that day |
| `…series[].invitesNeeded` | integer | How many more to invite, as of that day |
| `…series[].trendDirection` | `"improving" \| "steady" \| "declining" \| "unknown"` | The direction as of that day |
| `…series[].trendReason` | string | The one-sentence explanation as of that day |
| `…series[].fragile` | boolean | At target, no headroom, at least one weak tester |
| `…series[].nudgesSent` | object | Nudges enqueued that day, so an intervention can be read against its effect |
| `…series[].nudgesSent.confirm` | integer | Will-you-test nudges enqueued that day |
| `…series[].nudgesSent.store` | integer | Store-link nudges enqueued that day |
| `…series[].nudgesSent.inactive` | integer | Inactivity nudges enqueued that day |
| `…series[].nudgesSent.closing` | integer | Window-closing nudges enqueued that day |

**`cohort.reconciliation`** — honestly empty rather than absent.

| key | type | meaning |
|---|---|---|
| `cohort.reconciliation.supported` | `false` | Always false today. No store API reconciliation exists |
| `cohort.reconciliation.lastReconciledAt` | `null` | Always null today. The field exists so a future version has a home |
| `cohort.reconciliation.reason` | string | Why not, in one sentence — so "we checked and cannot" is distinguishable from "we never thought about it" |

**`cohort.disclaimer`** — required and non-nullable, so a client that spreads the cohort object cannot drop it.

| key | type | meaning |
|---|---|---|
| `cohort.disclaimer.authority` | `"google_play_console"` | Who owns the number that actually decides this. Not us |
| `cohort.disclaimer.readable` | `false` | Always false. No Google API exposes the opt-in count or the streak |
| `cohort.disclaimer.source` | `"pithy_invite_records"` | What Pithy's figure is derived from |
| `cohort.disclaimer.statement` | string | The sentence to render beside any opt-in figure |
| `cohort.disclaimer.divergenceRisks` | array of string | Why the two counts can differ: `silent_opt_out`, `opt_in_outside_pithy`, `uninstall`, `day_boundary_mismatch`, `reset_policy_assumed`. Never empty |

**`cohort.members`** — present under `roster` only.

| key | type | meaning |
|---|---|---|
| `cohort.members[].id` | string | The member id |
| `cohort.members[].email` | string | The invited address — the join key to the user record if they ever sign in |
| `cohort.members[].name` | string \| null | The display name the developer supplied |
| `cohort.members[].state` | `"invited" \| "accepted" \| "opted_in" \| "lapsed" \| "removed"` | Roster state, replayed from the event log. Inactivity never writes any of these |
| `cohort.members[].invitedAt` | ISO-8601 string | When the first invitation was sent |
| `cohort.members[].acceptedAt` | ISO-8601 string \| null | When they answered agreeing to test — a tap on a link, needing no account |
| `cohort.members[].estimatedOptedInAt` | ISO-8601 string \| null | When they followed Pithy's confirmation link. Our record that they clicked our link, not evidence Google recorded an opt-in |
| `cohort.members[].lapsedAt` | ISO-8601 string \| null | When they opted out or were removed. Written only by an explicit act |
| `cohort.members[].estimatedOptInDays` | integer | Days since they confirmed, on Pithy's record. Zero when they have not |
| `cohort.members[].activity` | object | The observed half, kept a separate object by design |
| `cohort.members[].activity.source` | `"observed"` | The literal discriminator |
| `cohort.members[].activity.observability` | `"observed" \| "unobservable" \| "unreachable"` | Whether we can see this tester at all, and why not when we cannot |
| `cohort.members[].activity.state` | `"active" \| "inactive" \| "never_linked" \| "unreachable"` | What the activity says. `never_linked` must render differently from `inactive` |
| `cohort.members[].activity.lastAuthenticatedAt` | ISO-8601 string \| null | The most recent sign of life |
| `cohort.members[].activity.inactiveSince` | ISO-8601 string \| null | Set only when the state is `inactive`. `null` for `never_linked`, because there is no "since" |
| `cohort.members[].activity.daysDark` | integer \| null | Days since the last sign of life, floored at their opt-in date |
| `cohort.members[].activity.sessionsInWindow` | integer | Sessions inside the cohort's window. Zero for a tester we cannot see |
| `cohort.members[].activity.devices` | array | Registered devices, most recently seen first |
| `cohort.members[].activity.devices[].platform` | `"ios" \| "android" \| "web"` | The device platform, from the auth device registry |
| `cohort.members[].activity.devices[].lastSeenAt` | ISO-8601 string | When this device was last seen signing in |
| `cohort.members[].activity.devices[].appVersion` | string \| null | The client app version at that sign-in |
| `cohort.members[].health` | integer 0–100 \| null | `null` for a tester we cannot observe. Null is not zero — absence of evidence is not evidence of risk |
| `cohort.members[].healthBasis` | `"scored" \| "unobservable" \| "unreachable"` | Why the health is null when it is null. Render `unobservable` gray, never red |
| `cohort.members[].riskBand` | `"healthy" \| "watch" \| "at_risk" \| "critical" \| "unknown"` | The band the score falls in, which selects the survival prior |
| `cohort.members[].dailySurvival` | number | The published daily-survival prior used for this tester in the forecast |
| `cohort.members[].factors` | array | Every term that produced the score, so it can be audited line by line |
| `cohort.members[].factors[].code` | string | A stable identifier for this term, e.g. `dark_8_10`. Safe for a UI to key off |
| `cohort.members[].factors[].points` | integer | The signed contribution. Penalties negative, credits positive |
| `cohort.members[].factors[].reason` | string | One sentence explaining this factor |
| `cohort.members[].lastNudgedAt` | ISO-8601 string \| null | When a nudge was last enqueued for them |
| `cohort.members[].nudgeCooldownUntil` | ISO-8601 string \| null | When they may be nudged again, or `null` if they may be now |
| `cohort.members[].unreachable` | boolean | Whether their address bounced or is suppressed. We cannot nudge them at all |

A failing run writes `{"error":{…}}` to stderr instead and exits 1 — the same public payload the HTTP surface encodes, with `detail` stripped.

## Errors

Each is a `PithyError`: the problem, then the action.

**The capability is not configured.**

```
The testers capability is not configured.
Add `testers({ baseUrl: '...' })` to pithy.config.ts (run `pithy add testers`).
```

**The capability will not load.** Distinct from the above, and classified rather than assumed. `@pithy-sh/testers` missing answers `The testers capability is not installed.` with `pithy add testers`; the package present with one of its own imports unresolved answers `The testers capability could not be loaded.` and tells you to install the project's dependencies — `pithy add` cannot fix that one. A package that resolves and throws or will not parse answers `The testers capability is installed and will not load.`

**A missing positional.**

```
Missing a cohort name.
Pass it: pithy testers create closed-test
```

**A flag that is not a number, or not one of a fixed set.**

```
--target-size must be a whole number above zero. Got "twelve".
Pass a number: --target-size 12
```

```
--platform must be one of android, ios. Got "windows".
Pass a supported value: --platform android
```

**A name longer than the deployment allows.**

```
That cohort name is longer than this deployment allows.
Keep it under 120 characters.
```

The number is the capability's own `maxNameLength`, which defaults to 120. A `--name` on `invite` is bounded the same way, and answers `That tester name is longer than this deployment allows.`

**`--env dev` on a provisioning subcommand.**

```
--env must be one of staging, prod. Got "dev".
This deploys to a Cloudflare account, and dev is local-only. Run `pithy dev` instead.
```

**No such cohort**, for any subcommand taking one — `resolveCohortRef` matches an id first, then a name.

```
No such cohort.
List your cohorts with `pithy testers list` and retry with an id from there.
```

**That address is not on this cohort**, from `remove`.

```
That address is not on this cohort.
Run `pithy testers roster closed-test` to see who is.
```

**Roster refusals**, from `invite`: `That tester is already on this cohort.` (use resend, which preserves their history), `That tester asked to be taken off this test.` (a withdrawal is theirs and durable), and `That cohort's roster is full.` — refused at the roster edge rather than days later as a rejected email list at the store.

**Provisioning refusals.** Missing Cloudflare credentials, a `pithy.config.ts` with no `name`, a missing `wrangler.jsonc` environment stanza or `DB` id, an account with no `workers.dev` subdomain, and:

```
This project's email-suppression database (acme-global-email-suppressions) does not exist.
Run `pithy email provision` first — the daily pass reads it to reconcile bounced addresses.
```

## Examples

Create a cohort and put people on it:

```
$ pithy testers create closed-test --store-url https://play.google.com/apps/testing/com.acme.app
closed-test: 12 testers for 14 days.
Carry more than 12 — that is the number that must still be standing at the end.
Done.
```

```
$ pithy testers invite closed-test --email sam@example.com --email pat@example.com
2 added to closed-test.
Run `pithy testers run` to ask them whether they will test.
Done.
```

Read where a cohort stands:

```
$ pithy testers status closed-test
Cohort:    closed-test
Estimated: 11 of 12 opted in. Day 6 of 14.
Observed:  9 active. 1 quiet 8+ days. 1 never signed in.
Forecast:  62% (41%–78%). moderate confidence.
Trend:     Steady. Opt-ins flat over the last week.

Invite 3 more.

This is Pithy's estimate from your own invite records.
Google's count is authoritative and no API exposes it.
```

Take the addresses that are waiting and paste them into the Play console:

```
$ pithy testers pending closed-test --json
{"command":"testers pending","cohort":"7c2f…","emails":["sam@example.com","pat@example.com"]}
```

Run a pass by hand without sending anything:

```
$ pithy testers run --cohort closed-test --skip-nudges --json
{"command":"testers run","results":[{"cohortId":"7c2f…","snapshotOn":"2026-08-08","nudged":{"confirm":0,"store":0,"inactive":0,"closing":0},"estimatedOptedInCount":11,"estimatedHeldDays":6,"trendDirection":"steady","pruned":0}]}
```

Deploy the daily pass to every declared environment:

```
$ pithy testers provision --json
{"command":"testers provision","results":[{"env":"staging","worker":"acme-staging-testers"},{"env":"prod","worker":"acme-prod-testers"}],"sends":true}
```

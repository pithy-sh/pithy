# @pithy-sh/testers

The roster, the invitations, and the fourteen-day clock — for the closed test Google Play makes every new personal developer account run before it will grant production access.

Twelve testers, opted in for fourteen continuous days. Lose one on day nine and the clock effectively restarts. There is no screen anywhere that tells you where you stand, which is the entire problem.

## The estimate, and why it is one

**Pithy's count is an estimate from your own invite records. Google's count is authoritative and no API exposes it.**

That sentence appears in this README, in the API response as a required field, in the CLI output of every status command, and at the foot of every email this capability sends. It is not a disclaimer bolted on afterwards; it is the shape of the thing.

Google computes the opt-in count and the continuous-day streak in Play Console and exposes neither. Not the roster, not the number, not a tester quietly opting out. `packages/testers/docs/store-apis.md` sets out exactly what the Play Developer API does and does not cover, with citations. Read it before assuming any part of this talks to Google.

So this capability owns its own model: who you invited, who signed in, who followed its confirmation link, and a clock replayed from those events. That is a well-informed estimate of Google's figure, and the two can diverge — most obviously when a tester opts out without telling anyone, which Google sees and we cannot.

Every field derived from it is named `estimated`. `successProbability` is nullable, so "we do not know" is representable rather than faked as a plausible number. `reconciliation.supported` is `false` with the reason attached, because "we checked and cannot" and "we never considered it" are different facts.

## The half that is fact

Activity is not an estimate. Because `@pithy-sh/auth` owns sessions and the device registry, a tester's invited address resolves to their user, and from there to when they last opened the app.

This is the only early-warning signal that exists. A tester dark for eight days is the one most likely to have quietly opted out or uninstalled, and that is actionable on day eight rather than on day fourteen when the count finally moves.

**Activity is never treated as opt-in continuity.** A tester who confirmed and never opens the app still counts toward Google's twelve — Google counts opt-ins, not engagement — so going quiet makes someone look alarming in the health column and never removes them from the count.

The caveat, stated rather than discovered: **activity exists only for testers who authenticate.** Someone who installs and never signs in is invisible, and an app whose test flow requires no sign-in produces no activity data at all. Those testers report `never_linked` rather than `inactive`, their health is `null` rather than a low score, and the forecast widens its confidence band in exact proportion to how much of the cohort is unobservable. A UI must render them gray, never red — absence of evidence is not evidence of risk.

## Add it

```
pithy add testers
pithy migrate
pithy testers provision
```

`pithy add testers` writes the `DB` binding and a `testers({...})` block into your Worker's `pithy.config.ts`. Set `baseUrl` before you send anything — an email cannot carry a relative link.

`provision` deploys the prebuilt Worker that hosts the daily pass and binds `TESTERS_DAILY`. It creates nothing else — no bucket, no index, no secret — which is a short list on purpose: a capability that needs less provisioning is one an adopter is more likely to finish setting up. Skip it and everything works except the 05:00 pass, so you would run `pithy testers run` yourself.

No secret to provision. The confirmation link is a random token on the tester's own row rather than a signature, which is what lets `pithy testers invite` build a working invitation against any environment — and what makes removing a tester actually revoke their link, where a signed one could only expire.

Add `email(...)` to the same Worker if it is not there already. Invitations and nudges are enqueued through it, so they inherit its retries, suppression list, and bounce handling rather than opening a second delivery path with none of them.

## Configure

```ts
testers({
  baseUrl: "https://api.example.com",
  cohortDefaults: {
    targetSize: 12,   // Play's floor
    windowDays: 14,   // Play's window
    maxRosterSize: 100,
  },
  nudges: { cooldownHours: 72 },
})
```

Every constant behind the forecast is a config field, including the survival priors and the health weights. They are numbers we chose, not values fitted to anybody's data, and the API says so in a `calibration` field. If you disagree with them, change them — and bump `modelVersion`, so your trend chart annotates where your change took effect. A chart that silently spans two models is a lie.

## Run it

Every operation the dashboard performs has a command, non-interactive and `--json`:

```
pithy testers create closed-test --store-url https://play.google.com/apps/testing/com.example.app
pithy testers invite closed-test --email ada@example.com
pithy testers run                    # ask them, chase them, record the day
pithy testers status closed-test
```

```
Cohort:    closed-test
Estimated: 12 of 12 opted in. Day 9 of 14.
Observed:  9 active. 2 quiet 8+ days. 1 never signed in.
Forecast:  71% (55–84%). moderate confidence.
Trend:     Declining. Two testers went dark this week.

This is Pithy's estimate from your own invite records.
Google's count is authoritative and no API exposes it.
```

The last two lines print on every invocation, including `--json`. They are not behind a flag, because a developer reading "day 13 of 14" is about to make a decision on it.

## Two emails, and why it cannot be one

A tester's journey is two links, and the order is forced by the store rather than chosen.

**The store's opt-in page only works once that address is already on the tester list** — and adding an address to a Play email list is precisely what the Play Developer API cannot do, so it is a manual step in the console. Send the store link before that step completes and the tester gets `App not available`, which reads to them as a broken app.

So: the first email asks whether they will help, and records their answer. You add the confirmed addresses to Play Console. The second email carries the link that leads them to the store's own opt-in page.

That also keeps the count honest. Saying yes is consent; it is not enrollment, and counting it as one would inflate the estimate with people who agreed and never joined. `accepted` and `opted_in` are separate states for that reason.

**The store link is rendered, never redirected to.** A 302 would make your Worker a redirector, and it leaves nowhere to put the two instructions that prevent most failures: open the link in a browser rather than the store app, and sign in with the address the email reached you at.

## The clock

The streak is **replayed from an append-only event log**, never stored as a counter. A counter can only be overwritten, which destroys both the old value and the evidence that it changed. Replaying makes a correction an insert: add the event that was missing, recompute, and every snapshot written beforehand survives as an accurate record of what Pithy believed on that day — which is exactly what a trend chart claims to show.

Only four things move a tester's state: an invitation, their answer to it, following the link through to the store, and an explicit opt-out or removal. Signing in to your app is **not** one of them — that is activity, and it belongs entirely to the observed half. **Inactivity is not one of them**, and that is load-bearing. The moment a cron is allowed to lapse someone for going quiet, the count stops being a record of who confirmed and becomes a guess dressed as a record.

Days are counted in **UTC**, and the response says so. Google's day boundary is undocumented and may not be ours — one more reason not to start trusting the estimate on day thirteen.

`resetPolicy` is exposed as the assumption it is. We do not know whether Play pauses or restarts the counter when you dip to eleven. The default is `reset`, deliberately pessimistic: being told day fourteen while actually on day three is the expensive mistake, and the reverse costs a shrug.

## The forecast, and the trend

Success needs two independent things, and they are reported separately: reaching the target, and holding it. Multiplying them into one percentage destroys the only actionable information in the pair. "62%" tells you nothing; "you will reach twelve (95%) but only hold it 65% of the time" tells you to invite four more people this afternoon.

The hold half is an **exact Poisson-binomial** over every opted-in tester's own survival probability — one convolution per tester, deterministic, and explainable in a sentence: we roll each tester's chance of lasting the remaining days into the exact odds that at least twelve of them do.

`invitesNeeded` is usually worth more than the probability beside it, and `recommendedRosterSize` answers the question a developer is actually asking. "Carry twelve" is the advice that fails, because twelve is the number that must still be standing at the end, not the number to start with.

A daily Workflow writes **one snapshot per cohort per UTC day**, and that table is what makes the trend chartable. The opt-in figures could always be replayed; **activity could not**. Sessions expire and rotate, and a tester who was quiet on the 9th but active on the 11th leaves no trace on the 12th that they were ever quiet. The early-warning signal has to be captured on the day or it is gone.

Each snapshot carries its own precomputed deltas and trend sentence, so a summary card renders from one row — no client-side series arithmetic, and therefore no way for the card and the chart to disagree.

## Nudges

Three kinds ship with default copy: confirm your opt-in, you have not opened the app recently, and the window is closing. Defaults are not a courtesy — without them the capability would only work if you bought a dashboard.

**The join links expire; the opt-out link never does.** `optInLinkTtlDays` bounds how long an invitation stays good, measured from the last time it was sent. Withdrawing is exempt, and deliberately so: nothing bounds outreach by that same number, so an opted-in tester is still nudged on day 40 while `lastInvitedAt` sits on day 0. Under one shared lifetime their unsubscribe link would have died on day 30 with the mail carrying it still arriving.

**Every nudge carries an opt-out link**, on all four kinds. Transactional mail normally carries none, but this capability asks one person for something repeatedly over a fortnight, and a tester being chased must be able to stop it. The link opens a page that asks, and a button on it withdraws them — two steps rather than one, because mail clients prefetch links and scanners follow them, and withdrawing rotates their token, so it is irreversible without a fresh invitation. The rotation is also what kills every link already sitting in their inbox.

**Chasing stops after three unanswered messages.** The cooldown bounds how *often* someone is mailed; this bounds how *many times*. The counter resets when they answer — accepting the invitation or confirming the opt-in, the two replies this asks for. Opening the app does not clear it, because activity is a separate signal with its own penalties and a tester who installs but never replies is exactly who the cap is for. Once somebody has opted in they have no reply left to give, so three unanswered reminders stop their chasing for good; they stay on the roster and stay visible in `pithy testers roster`, they simply stop being mailed.

A **per-tester cooldown is enforced server-side on every path**, including the daily pass and `resend`. A nudge trigger with no guard is a button that mails the same twelve people repeatedly, and the fastest way to lose a cohort is to become the reason they muted you.

A control-plane caller may override **the words, and only the words**: a subject and a plain-text body. This capability owns the layout, the branding, the footer, and the rendering.

**There is no field that accepts HTML, and that is a security boundary rather than a style preference.** Supplied nudge content goes out to your users over your own DKIM signature. If it were unconstrained markup, a leaked dashboard credential would stop being a disclosure problem and become a phishing platform operating from a domain your testers already trust. The body is split into paragraphs and each renders HTML-escaped, so markup arrives as visible text — structurally, not by filtering. The subject is stripped of control characters, because the threat there is header injection rather than markup.

## Routes

| Route | Strategy | Purpose |
|---|---|---|
| `GET /testers/confirm/:token` | `public` | "Yes, I will test." Idempotent, no account required |
| `GET /testers/opt-in/:token` | `public` | Hands them the store's own opt-in link, and records it |
| `GET /testers/opt-out/:token` | `public` | The tester's own withdrawal, linked from every email |
| `GET /testers/status` | `bearer` \| `session` | A tester's own view of where they stand |
| `GET /testers/cohorts` | `control-plane` | Cohort state, roster, activity, forecast, and the trend series |
| `POST /testers/invite` | `control-plane` | Add an address and send its confirmation link |
| `POST /testers/resend` | `control-plane` | Another invitation, preserving existing history |
| `POST /testers/remove` | `control-plane` | Take a tester off a roster |
| `POST /testers/nudge` | `control-plane` | Mail selected testers. Copy overridable as text; cooldown enforced here |

The three public routes are deliberate. A tester must be able to answer from an email, on a phone, with no account — requiring a sign-in would mean the one event the whole count rests on happened only for the subset willing to create an account first. Each carries a high-entropy token and is idempotent, and an unknown token and a revoked one return identical words, so none of them is an oracle for which cohorts or testers exist.

Idempotency on the confirmation is a requirement rather than a nicety. Email clients prefetch links, scanners follow them, and people click twice when a page is slow. If a second visit re-stamped the opt-in date, every one of those would silently reset the tester's streak.

Read, write, and send are three separate control-plane scopes. One `testers:admin` flag would mean a credential issued to read a roster could also mail every person on it, and mailing is the operation whose blast radius reaches outside your own systems.

## Errors

| Code | Status | Meaning |
|---|---|---|
| `testers/cohort_not_found` | 404 | No cohort answers to that id |
| `testers/member_not_found` | 404 | No member answers to that id or address |
| `testers/invalid_token` | 400 | The link is not one of ours, or belongs to a removed tester |
| `testers/roster_full` | 409 | The cohort is at its cap |
| `testers/already_on_roster` | 409 | That address is already on the roster in a live state |
| `testers/nudge_cooldown` | 429 | Every selected tester is inside the cooldown, so nothing was sent |
| `testers/copy_not_allowed` | 403 | Copy override is disabled for this deployment |
| `testers/not_configured` | 500 | Composed but incomplete — no `baseUrl`, or a missing binding |

## Testing

`bunx vitest run` runs both projects. The pure logic — the clock replay, the Poisson-binomial, the health score, the trend rule, the token — is node-project and asserted against hand-computed values. Anything where a mock would assert the code rather than the constraint runs against real Miniflare D1.

## License

MIT.

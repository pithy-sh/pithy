# What the store APIs actually expose

This document exists because the most valuable thing `@pithy-sh/testers` can tell you is what it cannot do.

Read it before assuming any part of this capability talks to Google. It does not. Nothing here reads the Play Console, and nothing here can.

Every claim below carries the URL it came from. Where a claim is inferred rather than stated by the vendor, it says so.

---

## Google Play: the twelve-testers requirement

The rule, verbatim from the authoritative page: developers with personal accounts created after November 13, 2023 must "run a closed test for your app with a minimum of 12 testers who have been opted-in for at least the last 14 days continuously." ([App testing requirements for new personal developer accounts](https://support.google.com/googleplay/android-developer/answer/14151465))

Three details do most of the damage in practice.

**The days must be consecutive.** Google states it outright: "we won't count testers who opted in, tested for less than 14 days, and then opted out. Even if they opt back in so that they are opted in for a total of 14 days, these 14 days must be consecutive." ([same page](https://support.google.com/googleplay/android-developer/answer/14151465)) Lose one tester on day nine and the clock effectively restarts.

**Internal testing does not count.** Only closed testing satisfies the requirement. ([same page](https://support.google.com/googleplay/android-developer/answer/14151465))

**It applies to personal accounts.** Organization accounts are not subject to it. ([same page](https://support.google.com/googleplay/android-developer/answer/14151465))

The requirement launched at twenty testers and was later reduced to twelve, with the same fourteen-day window. Google maintains a [community guide](https://support.google.com/googleplay/android-developer/community-guide/255621488/everything-about-the-12-testers-requirement) on it. Treat "it used to be 20, it is now 12" as well established and the exact change date as unconfirmed — the secondary sources reporting December 11, 2024 are not Google.

### The hundred-tester figure is about a different track

You will see "maximum 100 testers" repeated widely. It is real, and it is about **internal** testing: "up to 100 testers per app." ([Set up an open, closed, or internal test](https://support.google.com/googleplay/android-developer/answer/9845334))

**Closed testing — the track the requirement actually runs on — has no such cap.** Its limits are 2,000 users per email list, 50 lists per track, and 200 lists per account. ([same page](https://support.google.com/googleplay/android-developer/answer/9845334)) Google states no maximum tester count on the requirement page at all.

This capability defaults a cohort's roster cap to 100 anyway, and the config field says why: a hundred is roughly the number of people one developer can still chase by hand. That is a management judgement, not a store limit, and you can raise it to 2,000.

---

## What the Play Developer API exposes

Very little, and none of the part you want.

**Tester management is Google-Groups-only.** The `edits.testers` resource has exactly one field — `googleGroups[]`, "All testing Google Groups, as email addresses." Its methods are `get`, `patch`, and `update`. There is no `list`, no per-tester resource, and no create or delete of an individual tester. ([edits.testers](https://developers.google.com/android-publisher/api-ref/rest/v3/edits.testers))

The limitation is documented on every method: "while it is possible in the Play Console UI to add testers via email lists, email lists are not supported by this resource." ([edits.testers.get](https://developers.google.com/android-publisher/api-ref/rest/v3/edits.testers/get))

So for the ordinary closed-testing setup — a list of email addresses added in the Console — the API is blind. It cannot read your roster, and it cannot write it.

**The opt-in count is not readable.** Not the streak, not the plain count. The full v3 resource inventory contains no testing-metrics resource at all ([REST index](https://developers.google.com/android-publisher/api-ref/rest)), and the Play Developer Reporting API covers app quality — crashes, ANRs, wake-locks — not tester counts ([Play Developer Reporting](https://developers.google.com/play/developer/reporting)). The figure lives on one Play Console screen, and developers report it as unreliable even there ([thread](https://support.google.com/googleplay/android-developer/thread/312314620)).

**Opt-out is not detectable.** There is no tester-state resource, and there is no webhook: Play's only push channel carries subscription and voided-purchase events, not testing events. Google clearly tracks opt-out server-side — its own wording depends on it — but exposes it only to its own eligibility check. ([REST index](https://developers.google.com/android-publisher/api-ref/rest))

**What the API does cover** is release management: `edits.tracks` handles releases, version codes, staged-rollout fractions, country targeting, and halt/resume. ([edits.tracks](https://developers.google.com/android-publisher/api-ref/rest/v3/edits.tracks)) That is genuinely useful and genuinely not this capability.

---

## Apple TestFlight, for contrast

App Store Connect exposes almost exactly what Google withholds.

`GET /v1/betaTesters` returns the roster with `firstName`, `lastName`, `email`, `inviteType`, and **`state`** — and testers can be added and removed individually. ([List beta testers](https://developer.apple.com/documentation/appstoreconnectapi/get-v1-betatesters))

`BetaTesterState` is a first-class readable attribute: `NOT_INVITED`, `INVITED`, `ACCEPTED`, `INSTALLED`, and `REVOKED` — where `REVOKED` means "The beta tester chose to stop testing, or was removed from the app." ([BetaTesterState](https://developer.apple.com/documentation/appstoreconnectapi/betatesterstate)) That is a machine-readable opt-out signal, which is the single largest gap between the two stores.

Per-tester sessions and crashes are still Console-only, and excluded even from Apple's own CSV export. ([View and manage tester information](https://www.developer.apple.com/help/app-store-connect/test-a-beta-version/view-and-manage-tester-information))

**Apple has no minimum-tester or minimum-duration requirement.** Nothing analogous to Google's twelve-for-fourteen exists. What Apple does have is guideline 2.2, which prohibits distributing TestFlight builds "in exchange for compensation of any kind" — so the paid-tester-farm ecosystem that grew around Google's rule is an App Review violation on iOS. ([App Review Guidelines](https://developer.apple.com/app-store/review/guidelines/))

Auth is an ES256 JWT signed with a `.p8` key, and App Store Connect "rejects tokens with a lifetime greater than 20 minutes" for the TestFlight resources. ([Generating tokens](https://developer.apple.com/documentation/appstoreconnectapi/generating-tokens-for-api-requests))

---

## The sequencing this forces

Because the API cannot add an address to an email list, that step is manual — the developer does it in Play Console. And the opt-in link does not work for a tester until it is done: they get `App not available`, which reads to them as a broken app rather than as a step you have not taken yet.

So the tester's journey has to be two messages, not one:

1. **"Will you help test?"** — Pithy's own link, recording consent and confirming the address is deliverable and correct *before* it goes on a Google-visible list.
2. You add the confirmed addresses to Play Console.
3. **"You're on the list — here's the link"** — carrying the store's own opt-in page.

Pithy's second link records the click and then *renders* the store link with instructions rather than redirecting to it. A 302 would make the adopter's Worker a redirector, and it would leave nowhere to say the two things that prevent most failures: open it in a browser rather than the store app, and sign in with the address the email reached you at.

## What this capability therefore does

It owns its own model, and says so everywhere.

Pithy records who you invited, who agreed to test, and who followed the link through to the store, and replays a fourteen-day clock from those events. That is a well-informed estimate of the figure Google computes. It is not that figure, and the two diverge — most obviously when a tester opts out without telling anyone, which Google sees and Pithy cannot.

Every field derived from it is named `estimated`. Every response carries a required `disclaimer` naming Google as the authority and stating that no API exposes it. `reconciliation.supported` is `false` with the reason attached, because "we checked and cannot" and "we never considered it" are different facts.

**What Pithy reads that nobody else does is activity.** Because `@pithy-sh/auth` owns sessions and the device registry, a tester's invited address resolves to their user, and from there to when they last opened the app. That is fact, not estimate, and it is the only early-warning signal that exists: a tester dark for eight days is the one most likely to have quietly gone, and knowing on day eight beats discovering on day fourteen.

Activity is never treated as opt-in continuity. A tester who confirmed and never opens the app still counts toward Google's twelve, so silence makes someone look alarming in the health column and never removes them from the count.

The caveat that has to be stated rather than discovered: **activity exists only for testers who authenticate.** Someone who installs and never signs in is invisible, and an app whose test flow requires no sign-in produces no activity data at all. Those testers report `never_linked` rather than `inactive`, their health is `null` rather than a low score, and the forecast's confidence band widens to say how much of the cohort is unobservable.

---

## What a follow-up could add, and what it could not

Store-API integration is viable, but only if it is scoped honestly.

**Apple is worth building.** Roster reconciliation against `GET /v1/betaTesters`, opt-out alerting on the `REVOKED` transition, and feedback ingestion through the App Store Connect webhooks are all backed by documented endpoints. That is a real capability with no asterisks.

**Google is release automation, not tester automation.** Track promotion, staged rollout, and country targeting are first-class; tester management is not. A follow-up framed around "testers" on the Google side would guarantee that the most-requested feature — the twelve-of-fourteen meter — is the one thing that cannot be built.

**What must never be built:** a progress meter that claims to read Google's number. It would have to be either hand-entered by the developer or scraped from the Console, and scraping is fragile, terms-adjacent, and needs a real user session, which the service-account model does not have. A meter that looked authoritative and was neither would be worse than no meter at all.

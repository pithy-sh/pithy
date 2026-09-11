---
"@pithy-sh/email": patch
---

The email scheduler asks whether anything is due before it starts a Workflow.

The host's cron fires every minute and started a scheduler Workflow unconditionally — the only gate was `SCHEDULER_ENABLED`, and nothing looked at the queue. "Is anything due" was asked *inside* the Workflow, so an idle minute cost an instance creation and a billed step before it could discover there was nothing to do: wake, create instance, persist step, query D1, find nothing, exit. 1,440 times a day, per environment.

On Workers Free that is the whole problem. The allowance is 3,000 steps a day, account-wide, and a default project provisions staging and prod — so the email host alone consumed 96% of it while sending no mail, and anything that actually sent competed for the remaining 4%.

`scheduled()` now runs the due query first and creates the Workflow only when a row comes back. **The probe and the tick share one predicate** rather than restating it — a second copy is a second thing to drift, and drifting closed would silently skip mail that was due. The batch-size check runs before the probe, so a misconfigured worker still says so on its first tick rather than its first busy one.

Nothing about delivery changes. The scheduler was never on the critical path for an immediate send, which resolves its sender and starts its Workflow inline; it serves scheduled and timezone jobs whose `sendAt` has arrived, plus the safety net for rows past their grace and sends past `stuckMs` — all already on a one-minute tolerance.

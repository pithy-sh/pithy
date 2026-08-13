---
"@pithy-sh/email": patch
---

Stop the scheduler re-driving a batch's own queue while it is still working through it.

#327 made the *head* of a send batch honest: the job in a step is patched on the heartbeat clock, so a batch that backs off and resumes is not read as stranded. It said nothing about the jobs behind it.

`runScheduler` claims a whole batch up front — every id stamped with the one instant of the claim — and dispatches a single send Workflow for it. That Workflow walks the list one job at a time, and nothing writes to a job it has not reached. So the tail keeps the claim instant, and a batch that takes longer to walk than `stuckMs` has its unreached jobs re-driven out from under it: a second send Workflow starts against a job the first is still coming for, `runSend` short-circuits only a job already `sent`, and both render and both call `send`. One person, two emails — #327's outcome, from a direction its fix did not cover, and it needs no crash and no resume. It needs a queue longer than the timeout. At the shipped defaults — fifty jobs a batch, fifteen minutes — that is a batch averaging eighteen seconds a job.

Liveness is a property of the **batch**, not of a row, so the batch says so. `renewClaim` stamps `updatedAt` on every still-`sending` job the batch holds, and each send step runs it over the jobs behind that one. In the step body, never as a step of its own: a step's result is journalled, its body is not, so the renewal runs on every attempt and never comes back from a journal — a resume renews the tail the moment it does real work again, and a backing-off retry renews it on each attempt. No job in a batch is then staler than the attempt currently running.

The scheduler is unchanged. `updatedAt` still means what it has always been read as meaning; it is simply now written by the whole batch rather than by one step of it, so `stuckMs` measures the driver rather than the row. It was not widened, and it should not be: a timeout tuned to outrun a queue is a race with a slower horse, and every job an adopter adds lengthens the queue.

A batch that genuinely dies mid-queue still has its tail recovered — the renewal renews a claim, it does not resurrect one, so a job that has left `sending` is left alone.

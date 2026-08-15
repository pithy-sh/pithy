---
"@pithy-sh/email": minor
---

A single bad recipient no longer blocks the rest of a send batch — which is what this file has always said it did.

`runSendBatch`'s docblock has promised since the file was written that *each job is independently retried and backed off by the Workflow runtime, so a single bad recipient never blocks the rest of the batch*. The loop did not do it. A step whose retries were spent threw, the throw came out of the loop, and every job behind it went unsent — on that attempt and on **every replay of the body**, because a Workflow re-executes from the top and serves the journal, arriving at the same failing step again. A batch of fifty lost forty-seven messages to one recipient whose template would not render or whose row was deleted mid-flight.

Each job is contained now, on `testers`' `runDurableDailyPass` shape. `runSendBatch` returns a `BatchSendReport`: one entry per job, `attempted` carrying the send's outcome, `unfinished` carrying the job id alone. The two share no field, so a job the batch could not finish cannot be read as one `runSend` concluded on. `EmailSendWorkflow.run` returns it, so the record is the instance's own output, beside the failed step in its journal.

**The step runner is not one of the contributors.** A send that ran and failed is contained; a runner that will not start the step at all is the durable mechanism refusing — an instance being torn down — and that is rethrown. A body that keeps calling a runner which has refused is a body that has not noticed it is being killed.

**Nothing from the throw travels.** What a send throws carries a recipient's address, a provider's response, and sometimes the rendered link itself, and none of it belongs in a value the instance publishes. The row is left where the scheduler's `stuckMs` re-drive finds it.

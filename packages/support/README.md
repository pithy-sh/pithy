# @pithy-sh/support

A support inbox that lands mail — and your signed-in users' own reports — in your own D1, classifies both on your own Workers AI binding, and links each sender to the account and purchases your app already knows about.

Support is the employee a solo developer cannot hire. Every piece needed to build one was already in the catalog, and nothing composed them. This does.

```sh
pithy add support
```

**Documentation: [pithy.sh/docs/capabilities/support](https://pithy.sh/docs/capabilities/support).** Overview, adding it, using it, and the reference: the MX constraint, provisioning, classification, provenance.

**A shared inbox.** Assign a conversation to somebody, filter the inbox by who has it, and see who else has a thread open before you reply: `POST /support/threads/:id/assign` behind `support:threads:assign`, `assignee=<ref>` or `assignee=none` on the listing, every handover kept in the thread's history, and one `support.thread` presence room per thread, with `viewing` and `replying`. Your own signed-in staff reach both through `support({ staff: { readPower, assignPower } })`, on unassignable roles other than the one ownership transfer confers, so only an operator can confer them. The seam is [`docs/CONTROL-PLANE.md`](../../docs/CONTROL-PLANE.md).

_Everything else is on the site. `pithy.sh/docs` is canonical — new prose goes there, not here._

## A person's data

**Erased.** When an account is purged, support deletes every thread linked to the account, or sent from its address and linked to no other account, with every message, attachment and raw mail in R2, classification, read state and assignment history, and an export hands the threads, messages, attachments and assignment history back first. The export leaves out who made each assignment: that is the operator's, and the audit trail keeps it with its actor. A staff member's purge takes their id off every handover they made as a signed-in user on someone else's thread, and their export lists those handovers by thread and time, without the assignee or the note. Who held a thread is kept until the customer's thread goes: an assignee is an opaque reference and a name the assigner chose, and support cannot tell which reference is a person. See [`@pithy-sh/auth`'s account lifecycle](../auth/docs/account-lifecycle.md#what-each-capability-does-with-a-persons-rows).

## License

MIT.

---
"@pithy-sh/core": patch
"@pithy-sh/support": patch
---

Close the exemption the projection walk still granted, and enforce a support invariant that was only written down.

`unpublishedIn` was extracted to end a fallthrough that returned `[]` for any type the walk could not name. One survived the extraction, wearing the branch that looked safe: `typeof` answers `"object"` for a `Date`, a `Map`, a `Set` and every class instance, and each of those descends to no keys and no leaves — a `Map`'s entries are not own properties, a getter lives on the prototype — so the descent handed out the same exemption the module exists to refuse. A row carrying a `Map` of ciphertext passed clean. So did a class instance whose only field was a getter returning a secret.

The rule is now what the walk can see rather than a list of types it distrusts: a container is one whose whole contents `Object.entries` returns — prototype `Object.prototype`, `Array.prototype`, or `null` — and anything else is refused where `undefined` and `bigint` already were, naming the class in the message. `leavesIn` and `keysIn` descend on the same terms, because a caller builds its declaration from those and a value walked to nothing becomes a permitted set with a field missing from it. Round-trip through JSON first; that is what crosses. This primitive guards four disclosure surfaces, and the hole was in all four.

`pithy_support_messages.fromAddress` was loosened to nullable for the one row that has no envelope — an answer delivered in the app — and the rule bounding that was prose on the field, in the same commit that put its sibling `emailJobId` behind a check on the object. It is a check now too, both ways: null exactly on an answer delivered in the app. A null on anything that traveled by mail is a thread nobody can answer, since the reply path addresses to it; an address on anything that did not claims a send that never happened.

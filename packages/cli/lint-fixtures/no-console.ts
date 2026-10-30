// Matched: a call, a method handed off, a method assigned, globalThis, a bound method, a tagged template,
// a type argument, a non-null assertion, a cast, an optional call on the method, a default value.
console.log("x");
items.forEach(console.log);
const sink = console.error;
globalThis.console.warn("y");
console.log.bind(console);
console.log`tpl`;
console.log<string>("x");
console.log!("x");
(console.log as never)("x");
console.log?.("x");
delete console.log;
function f(p = console.log) {}
const { a = console.log } = {};
new console.Console();
for (const x of console.list) {}
console
  .log(
    "multi",
  );
// Not matched: computed, optional member, another object's console, an alias, a written target,
// a parenthesized object.
console["log"]("z");
console?.log("q");
window.console.log("w");
foo.console.log("v");
const { log } = console;
console.log = () => {};
console.x++;
[console.y] = [1];
({ a: console.z } = {});
for (console.w in {}) {}
(console).log("p");
(globalThis.console).log;

// Matched: a write, a method handed off, either stream.
process.stdout.write("a");
process.stderr.write;
items.forEach(process.stdout.write);
process.stdout.columns;
// Not matched: through globalThis, optional, parenthesized, a written target, another stream.
globalThis.process.stdout.write("b");
process.stdout?.write("a");
process?.stdout.write("a");
(process.stdout).write("x");
process.stdout.write = () => true;
process.stdin.read();

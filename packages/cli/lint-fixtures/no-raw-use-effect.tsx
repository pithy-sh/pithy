// Matched: either hook, bare or on an object, with type arguments, inside a component.
useEffect(() => {}, []);
React.useEffect(() => {});
useLayoutEffect(() => {});
a.b.useEffect();
useEffect<void>(() => {});
React.useEffect<void>(() => {});
export default function C() {
  useEffect(() => {
    run();
  });
  return <div onClick={() => run()} />;
}
// Not matched: an optional call, a parenthesized callee, a reference, the right hooks.
useEffect?.(() => {});
React?.useEffect(() => {});
(useEffect)(() => {});
const hook = useEffect;
useRead(() => fetch("/"));
useSyncExternalStore(subscribe, read);

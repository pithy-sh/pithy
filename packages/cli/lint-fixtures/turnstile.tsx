// A hook file the starter excludes from no-raw-use-effect by name: neither linter reports it.
export function Turnstile() {
  useEffect(() => {}, []);
  return null;
}

import type { ReactNode } from "react";
import { Router, useExpoRouterAdapter } from "../src/router";

/** Every path but `/`, handed to the kit's router. `src/router.tsx` reads the path and the query through the adapter. */
export default function Pithy(): ReactNode {
  return <Router adapter={useExpoRouterAdapter()} />;
}

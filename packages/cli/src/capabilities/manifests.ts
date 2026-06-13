import { CapabilityManifest } from "@pithy-sh/core/src/capability/manifest";
import { NotFoundError } from "@pithy-sh/core/src/error/pithyError";

/**
 * Phase 0 static manifest registry — empty until capability packages ship.
 * Phase 1 replaces this with reading `pithy.manifest.json` from the installed
 * package, validated through the same `CapabilityManifest` schema.
 */
const KNOWN: Record<string, unknown> = {};

/** Resolve a capability's manifest by name; unknown names fail with the Phase 0 state. */
export async function loadManifest(name: string): Promise<CapabilityManifest> {
  const raw = KNOWN[name];
  if (raw === undefined) {
    throw new NotFoundError({
      message: `No capability named "${name}".`,
      action: "No capabilities ship in Phase 0. They land in Phase 1.",
    });
  }
  return CapabilityManifest.parse(raw);
}

/** Every known capability manifest, validated — what `pithy add --list` shows. Empty in Phase 0. */
export function availableManifests(): CapabilityManifest[] {
  return Object.values(KNOWN).map((raw) => CapabilityManifest.parse(raw));
}

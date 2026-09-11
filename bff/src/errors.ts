/**
 * The human-readable part of anything thrown. `web/src/lib/errors.ts` is the
 * twin; the two packages cannot import from each other.
 */
export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

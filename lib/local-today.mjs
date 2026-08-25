/**
 * lib/local-today.mjs — compatibility shim. The module moved to src/lib/ (ADR 0007).
 *
 * The web dashboard resolves this by literal path under careerOpsRoot()
 * (web/src/lib/core/pipeline.ts) and may point at a checkout it did not
 * upgrade in lockstep, so the old path has to keep resolving.
 */
export { localToday } from '../src/lib/local-today.mjs';

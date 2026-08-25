/**
 * lib/cli-flags.mjs — compatibility shim. The module moved to src/lib/ (ADR 0007).
 *
 * Kept alongside local-today.mjs for out-of-tree callers that import this
 * layer by literal path; nothing in this repo imports it here any more.
 */
export { flagValue, hasFlag, validateFlags } from '../src/lib/cli-flags.mjs';

// tests/tracker-flag-value-parity.test.mjs — pins the flagValue consolidation.
//
// tracker.mjs carried its own flagValue (one of the 3 copies ADR 0002 counts).
// ADR 0004 D6 names src/lib/cli-flags.mjs's contract the winner, which src/core/
// flags.js absorbs. The two implementations differ in exactly two ways:
//
//   - absent/valueless answers `undefined` rather than `null`
//   - the `--flag=value` form is read BEFORE the space-separated one
//
// Both are unobservable at tracker.mjs's 9 call sites, which every one of them
// consumes as a truthiness test or through `|| '<default>'`. This test records
// that: same truthiness, same string, for every argv shape the CLI accepts.
import { pass, fail } from './helpers.mjs';
import { flagValue } from '../src/core/flags.js';

console.log('\ntracker.mjs — flagValue parity with src/core/flags.js');

// The pre-consolidation tracker.mjs:373 implementation, kept here as the oracle.
function legacyFlagValue(args, flag) {
  const idx = args.indexOf(flag);
  if (idx !== -1 && args[idx + 1] !== undefined && !args[idx + 1].startsWith('--')) return args[idx + 1];
  const kv = args.find(a => a.startsWith(flag + '='));
  return kv ? kv.split('=').slice(1).join('=') : null;
}

const cases = [
  [['--status', 'Applied'], '--status'],          // space-separated
  [['--status=Applied'], '--status'],             // equals form
  [['--status='], '--status'],                    // equals, empty value
  [['--status=a=b'], '--status'],                 // value containing '='
  [['--status'], '--status'],                     // flag with no value
  [['--status', '--json'], '--status'],           // ADR 0004 D6: must not swallow
  [[], '--status'],                               // absent
  [['--id', '7', '--limit', '3'], '--limit'],     // later flag
  [['--out', '-'], '--out'],                      // single dash is a value
];

let failures = 0;
for (const [argv, flag] of cases) {
  const legacy = legacyFlagValue(argv, flag);
  const core = flagValue(argv, flag);
  const sameTruth = Boolean(legacy) === Boolean(core);
  // Only the string matters when either produced one; null/undefined are
  // interchangeable at every tracker.mjs call site.
  const sameValue = (legacy ?? undefined) === (core ?? undefined);
  if (!sameTruth || !sameValue) {
    fail(`flagValue(${JSON.stringify(argv)}, '${flag}'): legacy=${JSON.stringify(legacy)} core=${JSON.stringify(core)}`);
    failures++;
  }
}

if (failures === 0) pass(`flagValue matches the tracker.mjs contract across ${cases.length} argv shapes`);

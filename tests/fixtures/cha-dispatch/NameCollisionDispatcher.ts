// Issue #2139: interface-typed receiver dispatch where an EARLIER
// resolution tier (import-aware, matching call.name regardless of receiver)
// resolves first and short-circuits before CHA/RTA ever runs — the reason
// `src/shared/hierarchy.ts`'s `resolveViaRepo` never CHA-expanded
// `repo.getClassHierarchy()` on the native engine: `getClassHierarchy` is
// ALSO an importable free function, exactly like `greet` here.
import { CasualGreeter } from './CasualGreeter.js';
import { FormalGreeter } from './FormalGreeter.js';
import { greet } from './greet.js';
import type { IGreeter } from './IGreeter.js';

// Typed parameter — typeMap records g: IGreeter (confidence 0.9). CHA should
// expand g.greet() to all instantiated IGreeter implementations, additively
// to (not instead of) whatever the free-function import match produces.
function dispatchGreeting(g: IGreeter): string {
  return g.greet();
}

export function runGreetings(): string {
  const formal = new FormalGreeter();
  const casual = new CasualGreeter();
  return dispatchGreeting(formal) + dispatchGreeting(casual) + greet();
}

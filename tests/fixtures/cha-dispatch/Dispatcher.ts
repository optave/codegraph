import { ConcreteWorker } from './ConcreteWorker.js';
import type { IWorker } from './IWorker.js';
import { MockWorker } from './MockWorker.js';
import { Tiger } from './Tiger.js';

// Typed parameter — typeMap will record worker: IWorker (confidence 0.9).
// CHA should expand worker.doWork() to all instantiated IWorker implementations.
function dispatch(worker: IWorker): string {
  return worker.doWork();
}

export function run(): string {
  const w1 = new ConcreteWorker();
  const w2 = new MockWorker();
  // GhostWorker is never instantiated — RTA excludes it from CHA targets.
  // Tiger IS instantiated (issue #2243) — gives the CHA expansion post-pass
  // real RTA evidence for Lion's sibling subclass, so the "does NOT
  // CHA-expand Lion.speak to sibling Tiger.speak" test actually exercises
  // the super-dispatch guard instead of passing by RTA-filter accident.
  // Deliberately not called — an unrelated run -> Tiger.speak call edge
  // would add noise unrelated to what this fixture is testing (Greptile
  // review on PR #2403).
  const _tiger = new Tiger();
  return dispatch(w1) + dispatch(w2);
}

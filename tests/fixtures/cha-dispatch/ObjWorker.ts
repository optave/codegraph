import type { IWorker } from './IWorker.js';

// Issue #2346: instantiated ONLY as an object-literal property value — never
// as `const x = new ObjWorker()` (every other IWorker implementor in this
// fixture set already uses that variable-declarator shape, which both engines'
// typeMap seeding has always recognized as confidence-1.0 instantiation
// evidence). The WASM engine's `newExpressions` list (Phase 8.5) already
// captures every `new X()` in a file regardless of assignment shape, so RTA
// already treated ObjWorker as instantiated there. The native engine's RTA
// evidence, before the #2346 fix, came ONLY from typeMap confidence>=0.9
// entries — and constructor typeMap seeding only fires when a `new_expression`
// is the direct value of a variable declarator or a `this.prop = ` assignment,
// so a `new X()` buried inside an object-literal property value was invisible
// to native's CHA/RTA filter even though `dispatch(worker: IWorker)` in
// Dispatcher.ts should CHA-expand to it just like ConcreteWorker/MockWorker.
export class ObjWorker implements IWorker {
  doWork(): string {
    return 'obj';
  }
}

// Object-literal-property-value instantiation — NOT a variable declarator.
const objWorkerTable: Record<string, IWorker> = { w: new ObjWorker() };

// Keep the table referenced so it isn't dead code — mirrors the real-world
// object-literal dispatch-table shape this RTA gap was found in.
export function describeObjWorkerTable(): string {
  return Object.keys(objWorkerTable).join(',');
}

import type { IShape } from './IShape.js';

// Abstract middle tier — never instantiated directly. Implements IShape
// (not extends), so a subclass added under this class is only reachable
// from IShape's other implementors (e.g. Circle) via the ancestral
// interface name, not via AbstractShape itself.
export abstract class AbstractShape implements IShape {
  abstract render(): string;
}

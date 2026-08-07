import { Circle } from './Circle.js';
import type { IShape } from './IShape.js';

// Typed parameter dispatching via the top-level interface, not any
// intermediate class — CHA must expand to every transitively instantiated
// IShape implementor, however many hops below IShape it sits.
function process(shape: IShape): string {
  return shape.render();
}

export function run(): string {
  const c = new Circle();
  return process(c);
}

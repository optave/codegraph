import type { IShape } from './IShape.js';

// Implements IShape directly (not through AbstractShape) — a sibling branch
// under the same interface, unrelated to the AbstractShape hierarchy.
export class Circle implements IShape {
  render(): string {
    return 'circle';
  }
}

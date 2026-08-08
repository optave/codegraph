import type { IGreeter } from './IGreeter.js';

export class FormalGreeter implements IGreeter {
  greet(): string {
    return 'Good day.';
  }
}

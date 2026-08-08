import type { IGreeter } from './IGreeter.js';

export class CasualGreeter implements IGreeter {
  greet(): string {
    return 'hey';
  }
}

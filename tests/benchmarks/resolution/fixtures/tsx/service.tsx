import type { User } from './types';
import { formatErrors, validateUser } from './validators';

const store: Map<string, User> = new Map();

function generateId(): string {
  return Math.random().toString(36).slice(2);
}

export function createUser(name: string, email: string): User {
  const result = validateUser(name, email);
  if (!result.valid) {
    throw new Error(formatErrors(result));
  }
  const id = generateId();
  const user: User = { id, name, email };
  store.set(id, user);
  return user;
}

export function getUser(id: string): User | undefined {
  return store.get(id);
}

export function removeUser(id: string): boolean {
  return store.delete(id);
}

export function listUsers(): User[] {
  return Array.from(store.values());
}

import { createUser, getUser, removeUser, listUsers } from './service';
import { validateUser, formatErrors } from './validators';
import type { User, ValidationResult } from './types';

function UserCard(props: { user: User }): string {
  return `<div>${props.user.name} (${props.user.email})</div>`;
}

function ErrorBanner(props: { message: string }): string {
  return `<div class="error">${props.message}</div>`;
}

export function App(): string {
  const check: ValidationResult = validateUser('Alice', 'alice@example.com');
  if (!check.valid) {
    const msg = formatErrors(check);
    return ErrorBanner({ message: msg });
  }

  const user = createUser('Alice', 'alice@example.com');
  const found = getUser(user.id);
  if (!found) {
    return ErrorBanner({ message: 'User not found' });
  }

  const card = UserCard({ user: found });
  const all = listUsers();
  removeUser(user.id);
  return card;
}

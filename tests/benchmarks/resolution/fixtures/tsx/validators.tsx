import type { ValidationResult } from './types';

function isValidEmail(email: string): boolean {
  return email.includes('@') && email.includes('.');
}

function isValidName(name: string): boolean {
  return name.length >= 2;
}

export function validateUser(name: string, email: string): ValidationResult {
  const errors: string[] = [];
  if (!isValidName(name)) {
    errors.push('Name too short');
  }
  if (!isValidEmail(email)) {
    errors.push('Invalid email');
  }
  return { valid: errors.length === 0, errors };
}

export function formatErrors(result: ValidationResult): string {
  return result.errors.join(', ');
}

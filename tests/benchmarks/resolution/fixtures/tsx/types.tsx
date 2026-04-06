export interface User {
  id: string;
  name: string;
  email: string;
}

export interface ValidationResult {
  valid: boolean;
  errors: string[];
}

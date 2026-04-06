package main

import (
	"errors"
	"strings"
)

// ValidationError holds a user-friendly validation message.
type ValidationError struct {
	Field   string
	Message string
}

// Error implements the error interface.
func (v *ValidationError) Error() string {
	return v.Field + ": " + v.Message
}

// ValidateUser checks that a User meets business rules.
func ValidateUser(u User) error {
	if err := validateName(u.Name); err != nil {
		return err
	}
	if err := validateEmail(u.Email); err != nil {
		return err
	}
	return nil
}

// validateName ensures the name is non-empty.
func validateName(name string) error {
	if strings.TrimSpace(name) == "" {
		return &ValidationError{Field: "name", Message: "must not be empty"}
	}
	return nil
}

// validateEmail performs a basic email check.
func validateEmail(email string) error {
	if !strings.Contains(email, "@") {
		return errors.New("invalid email format")
	}
	return nil
}

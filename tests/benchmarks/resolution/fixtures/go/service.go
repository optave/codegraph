package main

import "fmt"

// UserService orchestrates user operations using a repository.
type UserService struct {
	repo *UserRepository
}

// NewUserService creates a UserService backed by the given repository.
func NewUserService(repo *UserRepository) *UserService {
	return &UserService{repo: repo}
}

// CreateUser validates and persists a new user.
func (s *UserService) CreateUser(id, name, email string) error {
	u := User{ID: id, Name: name, Email: email}
	if err := ValidateUser(u); err != nil {
		return err
	}
	s.repo.Save(u)
	return nil
}

// GetUser retrieves a user by ID.
func (s *UserService) GetUser(id string) (User, error) {
	u, ok := s.repo.FindByID(id)
	if !ok {
		return User{}, fmt.Errorf("user %s not found", id)
	}
	return u, nil
}

// RemoveUser deletes a user by ID.
func (s *UserService) RemoveUser(id string) error {
	if !s.repo.Delete(id) {
		return fmt.Errorf("user %s not found", id)
	}
	return nil
}

// Summary prints a summary of the repository state.
func (s *UserService) Summary() string {
	count := s.repo.Count()
	return fmt.Sprintf("repository contains %d users", count)
}

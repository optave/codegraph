package main

import "fmt"

// User represents a domain entity.
type User struct {
	ID    string
	Name  string
	Email string
}

// UserRepository provides persistence for User entities.
type UserRepository struct {
	store map[string]User
}

// NewUserRepository creates and initializes a UserRepository.
func NewUserRepository() *UserRepository {
	return &UserRepository{
		store: make(map[string]User),
	}
}

// FindByID retrieves a user by ID.
func (r *UserRepository) FindByID(id string) (User, bool) {
	u, ok := r.store[id]
	return u, ok
}

// Save persists a user to the store.
func (r *UserRepository) Save(u User) {
	r.store[u.ID] = u
	fmt.Printf("saved user %s\n", u.ID)
}

// Delete removes a user by ID.
func (r *UserRepository) Delete(id string) bool {
	if _, ok := r.store[id]; !ok {
		return false
	}
	delete(r.store, id)
	return true
}

// Count returns the number of stored users.
func (r *UserRepository) Count() int {
	return len(r.store)
}

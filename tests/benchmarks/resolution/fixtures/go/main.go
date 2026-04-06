package main

import "fmt"

func main() {
	repo := NewUserRepository()
	svc := NewUserService(repo)

	if err := svc.CreateUser("1", "Alice", "alice@example.com"); err != nil {
		fmt.Println("error:", err)
	}

	if err := svc.CreateUser("2", "Bob", "bob@example.com"); err != nil {
		fmt.Println("error:", err)
	}

	u, err := svc.GetUser("1")
	if err != nil {
		fmt.Println("error:", err)
	} else {
		fmt.Printf("found: %s <%s>\n", u.Name, u.Email)
	}

	if err := svc.RemoveUser("2"); err != nil {
		fmt.Println("error:", err)
	}

	fmt.Println(svc.Summary())
}

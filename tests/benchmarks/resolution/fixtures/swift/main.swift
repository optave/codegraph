import Foundation

func run() {
    let service = createService()
    let user = service.createUser(id: "1", name: "Alice", email: "alice@example.com")
    if let u = user {
        print("Created user: \(u.name)")
    }

    if let found = service.getUser(id: "1") {
        print("Found: \(found.name)")
    }

    let removed = service.removeUser(id: "1")
    print("Removed: \(removed)")
}

func directRepoAccess() {
    let repo = UserRepository()
    let user = User(id: "2", name: "Bob", email: "bob@example.com")
    if validateUser(user) {
        repo.save(user)
    }
}

run()

import Foundation

class UserService {
    private let repo: UserRepository

    init(repo: UserRepository) {
        self.repo = repo
    }

    func createUser(id: String, name: String, email: String) -> User? {
        let user = User(id: id, name: name, email: email)
        if !validateUser(user) {
            return nil
        }
        repo.save(user)
        return user
    }

    func getUser(id: String) -> User? {
        return repo.findById(id)
    }

    func removeUser(id: String) -> Bool {
        return repo.delete(id)
    }
}

func createService() -> UserService {
    let repo = UserRepository()
    return UserService(repo: repo)
}

import Foundation

protocol Repository {
    associatedtype Entity
    func findById(_ id: String) -> Entity?
    func save(_ entity: Entity)
    func delete(_ id: String) -> Bool
}

class UserRepository: Repository {
    typealias Entity = User

    private var store: [String: User] = [:]

    func findById(_ id: String) -> User? {
        return store[id]
    }

    func save(_ user: User) {
        store[user.id] = user
    }

    func delete(_ id: String) -> Bool {
        return store.removeValue(forKey: id) != nil
    }

    func count() -> Int {
        return store.count
    }
}

struct User {
    let id: String
    let name: String
    let email: String
}

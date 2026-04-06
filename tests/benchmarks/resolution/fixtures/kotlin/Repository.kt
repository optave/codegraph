package benchmark

data class User(val name: String, val email: String)

open class Repository {
    private val store = mutableListOf<User>()

    open fun save(user: User): Boolean {
        store.add(user)
        return true
    }

    open fun findByName(name: String): User? {
        return store.firstOrNull { it.name == name }
    }

    open fun delete(name: String): Boolean {
        return store.removeIf { it.name == name }
    }
}

class UserRepository : Repository() {
    fun saveIfValid(user: User): Boolean {
        if (!validateName(user.name)) return false
        if (!validateEmail(user.email)) return false
        return save(user)
    }
}

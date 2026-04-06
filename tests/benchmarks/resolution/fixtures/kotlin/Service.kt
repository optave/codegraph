package benchmark

class UserService(private val repo: UserRepository) {

    fun createUser(name: String, email: String): Boolean {
        if (!validateName(name)) return false
        if (!validateEmail(email)) return false
        val user = User(name, email)
        return repo.saveIfValid(user)
    }

    fun getUser(name: String): User? {
        return repo.findByName(name)
    }

    fun removeUser(name: String): Boolean {
        return repo.delete(name)
    }
}

fun buildService(): UserService {
    val repo = UserRepository()
    return UserService(repo)
}

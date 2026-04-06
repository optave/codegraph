package benchmark

fun checkInput(name: String, email: String): Boolean {
    return validateName(name) && validateEmail(email)
}

fun main() {
    if (!checkInput("Alice", "alice@example.com")) return

    val svc = buildService()
    svc.createUser("Alice", "alice@example.com")
    val user = svc.getUser("Alice")
    if (user != null) {
        svc.removeUser(user.name)
    }
}

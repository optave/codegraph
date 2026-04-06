package benchmark

fun checkLength(value: String, min: Int, max: Int): Boolean {
    return value.length in min..max
}

fun validateEmail(email: String): Boolean {
    if (!checkLength(email, 3, 254)) return false
    return email.contains("@")
}

fun validateName(name: String): Boolean {
    if (!checkLength(name, 1, 100)) return false
    return name.isNotBlank()
}

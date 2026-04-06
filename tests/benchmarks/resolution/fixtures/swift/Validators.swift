import Foundation

func validateEmail(_ email: String) -> Bool {
    return email.contains("@") && email.contains(".")
}

func validateUser(_ user: User) -> Bool {
    guard !user.id.isEmpty, !user.name.isEmpty else {
        return false
    }
    return validateEmail(user.email)
}

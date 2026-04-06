object Validators {
  def validateEmail(email: String): Boolean = {
    email.contains("@") && email.contains(".")
  }

  def validateUser(user: User): Boolean = {
    validateEmail(user.email) && user.name.nonEmpty
  }
}

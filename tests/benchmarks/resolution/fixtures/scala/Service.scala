class UserService(repo: UserRepository) {
  def createUser(id: String, name: String, email: String): Option[User] = {
    val user = User(id, name, email)
    repo.save(user)
    Some(user)
  }

  def getUser(id: String): Option[User] = {
    repo.findById(id)
  }

  def removeUser(id: String): Boolean = {
    repo.delete(id)
  }
}

object ServiceFactory {
  def createService(): UserService = {
    val repo = UserRepository()
    UserService(repo)
  }
}

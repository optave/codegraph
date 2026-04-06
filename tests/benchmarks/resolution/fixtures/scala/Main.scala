object Main {
  def main(args: Array[String]): Unit = {
    val service = ServiceFactory.createService()
    val user = service.createUser("1", "Alice", "alice@example.com")
    user.foreach(u => println(u.name))

    val found = service.getUser("1")
    found.foreach(u => println(u.name))

    val removed = service.removeUser("1")
    println(removed)
  }

  def directRepoAccess(): Unit = {
    val repo = UserRepository()
    val user = User("2", "Bob", "bob@example.com")
    repo.save(user)
  }
}

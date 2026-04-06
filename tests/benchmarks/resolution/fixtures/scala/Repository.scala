case class User(id: String, name: String, email: String)

class UserRepository {
  def findById(id: String): Option[User] = {
    None
  }

  def save(user: User): Unit = {
    println(user.id)
  }

  def delete(id: String): Boolean = {
    false
  }
}

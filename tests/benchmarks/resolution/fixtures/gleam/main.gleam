import service
import repository

pub fn main() {
  let repo = repository.new_repo()
  let result = service.create_user(repo, "alice", "alice@example.com")
  let user = service.get_user(repo, "alice")
  let removed = service.remove_user(repo, "alice")
  let summary = service.summary(repo)
  result
}

pub fn new_repo() {
  []
}

pub fn save(repo, name, email) {
  [#(name, email), ..repo]
}

pub fn find_by_id(repo, id) {
  case repo {
    [] -> Error("not found")
    [#(name, email), ..rest] ->
      case name == id {
        True -> Ok(#(name, email))
        False -> find_by_id(rest, id)
      }
  }
}

pub fn delete(repo, id) {
  case repo {
    [] -> Error("not found")
    [#(name, _), ..rest] ->
      case name == id {
        True -> Ok(rest)
        False -> delete(rest, id)
      }
  }
}

pub fn count(repo) {
  count_helper(repo, 0)
}

fn count_helper(repo, acc) {
  case repo {
    [] -> acc
    [_, ..rest] -> count_helper(rest, acc + 1)
  }
}

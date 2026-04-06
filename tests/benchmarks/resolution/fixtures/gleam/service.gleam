import repository
import validators

pub fn create_user(repo, name, email) {
  let valid_name = validators.validate_name(name)
  let valid_email = validators.validate_email(email)
  case valid_name, valid_email {
    True, True -> repository.save(repo, name, email)
    _, _ -> Error("validation failed")
  }
}

pub fn get_user(repo, id) {
  repository.find_by_id(repo, id)
}

pub fn remove_user(repo, id) {
  repository.delete(repo, id)
}

pub fn summary(repo) {
  let count = repository.count(repo)
  format_summary(count)
}

fn format_summary(count) {
  "repository contains " <> int_to_string(count) <> " users"
}

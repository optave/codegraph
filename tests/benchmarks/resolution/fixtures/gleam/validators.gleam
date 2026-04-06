pub fn validate_name(name) {
  case name {
    "" -> False
    _ -> check_length(name, 1, 100)
  }
}

pub fn validate_email(email) {
  case email {
    "" -> False
    _ -> contains_at(email)
  }
}

fn check_length(value, min, max) {
  let len = string_length(value)
  len >= min && len <= max
}

fn contains_at(email) {
  string_contains(email, "@")
}

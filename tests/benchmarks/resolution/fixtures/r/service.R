source("validators.R")
source("repository.R")

create_user <- function(id, name, email) {
  validate_user_input(name, email)
  user <- list(id = id, name = name, email = email)
  save_user(user)
}

get_user <- function(id) {
  find_user_by_id(id)
}

remove_user <- function(id) {
  existing <- find_user_by_id(id)
  if (is.null(existing)) {
    stop("User not found")
  }
  delete_user(id)
}

validate_email <- function(email) {
  if (!grepl("@", email)) {
    stop("Invalid email address")
  }
  TRUE
}

validate_name <- function(name) {
  if (nchar(name) < 2) {
    stop("Name must be at least 2 characters")
  }
  TRUE
}

validate_user_input <- function(name, email) {
  validate_name(name)
  validate_email(email)
}

source("service.R")

run <- function() {
  user <- create_user("u1", "Alice", "alice@example.com")
  found <- get_user("u1")
  print(found)
  remove_user("u1")
  all <- list_all_users()
  print(all)
}

run()

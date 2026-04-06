user_store <- list()

save_user <- function(user) {
  user_store[[user$id]] <<- user
  user
}

find_user_by_id <- function(id) {
  user_store[[id]]
}

delete_user <- function(id) {
  user_store[[id]] <<- NULL
  TRUE
}

list_all_users <- function() {
  user_store
}

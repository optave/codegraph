require_relative "repository"
require_relative "validators"

def create_user(store, id, name, email)
  unless validate_user(name, email)
    raise ArgumentError, "Invalid user data"
  end
  user = { id: id, name: name, email: email }
  repo_save(store, id, user)
  user
end

def find_user(store, id)
  repo_find_by_id(store, id)
end

def find_user_by_email(store, email)
  repo_find_by_email(store, email)
end

def remove_user(store, id)
  repo_delete(store, id)
end

require_relative "service"

def run()
  store = {}
  create_user(store, "u1", "Alice", "alice@example.com")
  found = find_user(store, "u1")
  if found
    puts found[:name]
  end
  find_user_by_email(store, "alice@example.com")
  remove_user(store, "u1")
end

run()

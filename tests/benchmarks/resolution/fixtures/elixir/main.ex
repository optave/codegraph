defmodule Main do
  def run do
    store = UserRepository.new_store()
    store = UserService.create_user(store, "u1", "Alice", "alice@example.com")
    user = UserService.get_user(store, "u1")
    IO.inspect(user)
    _all = UserService.list_users(store)
    label = UserService.display_user(store, "u1")
    IO.puts(label)
    store = UserService.remove_user(store, "u1")
    store
  end
end

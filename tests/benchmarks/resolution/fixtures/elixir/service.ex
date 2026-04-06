defmodule UserService do
  def create_user(store, id, name, email) do
    case Validators.validate_user(name, email) do
      :ok ->
        user = %{id: id, name: name, email: email}
        UserRepository.save(store, id, user)

      {:error, reason} ->
        {:error, reason}
    end
  end

  def get_user(store, id) do
    UserRepository.find_by_id(store, id)
  end

  def remove_user(store, id) do
    UserRepository.delete(store, id)
  end

  def list_users(store) do
    UserRepository.list_all(store)
  end

  defp format_user(user) do
    "#{user.name} <#{user.email}>"
  end

  def display_user(store, id) do
    case get_user(store, id) do
      nil -> "not found"
      user -> format_user(user)
    end
  end
end

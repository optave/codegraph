defmodule UserRepository do
  def new_store do
    %{}
  end

  def save(store, id, user) do
    Map.put(store, id, user)
  end

  def find_by_id(store, id) do
    Map.get(store, id)
  end

  def delete(store, id) do
    Map.delete(store, id)
  end

  def list_all(store) do
    Map.values(store)
  end
end

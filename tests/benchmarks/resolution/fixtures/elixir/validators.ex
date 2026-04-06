defmodule Validators do
  def valid_email?(email) do
    String.contains?(email, "@") and String.contains?(email, ".")
  end

  def valid_name?(name) do
    String.length(name) >= 2
  end

  def validate_user(name, email) do
    case {valid_name?(name), valid_email?(email)} do
      {true, true} -> :ok
      {false, _} -> {:error, "Name too short"}
      {_, false} -> {:error, "Invalid email"}
    end
  end
end

def valid_email?(email)
  email.is_a?(String) && email.include?("@") && email.include?(".")
end

def valid_name?(name)
  name.is_a?(String) && name.length >= 2
end

def validate_user(name, email)
  valid_name?(name) && valid_email?(email)
end

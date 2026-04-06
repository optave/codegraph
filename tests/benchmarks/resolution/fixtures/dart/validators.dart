bool isNotEmpty(String value) {
  return value.isNotEmpty;
}

bool validateName(String name) {
  if (!isNotEmpty(name)) return false;
  return name.length >= 2;
}

bool validateEmail(String email) {
  if (!isNotEmpty(email)) return false;
  return email.contains('@');
}

bool validateAmount(double amount) {
  return amount > 0;
}

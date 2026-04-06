using System;

namespace Benchmark;

public static class Validators
{
    public static bool IsValidEmail(string email)
    {
        return !string.IsNullOrEmpty(email) && email.Contains("@");
    }

    public static bool IsValidName(string name)
    {
        return !string.IsNullOrEmpty(name) && name.Length >= 2;
    }

    public static bool ValidateUser(User user)
    {
        return IsValidEmail(user.Email) && IsValidName(user.Name);
    }
}

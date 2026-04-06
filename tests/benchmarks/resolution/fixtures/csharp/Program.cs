using System;

namespace Benchmark;

public class Program
{
    public static void Main(string[] args)
    {
        var repo = new UserRepository();
        var service = new UserService(repo);

        var user = new User { Id = "1", Name = "Alice", Email = "alice@example.com" };

        if (Validators.IsValidEmail(user.Email))
        {
            service.AddUser(user);
        }

        var found = service.GetUser("1");
        if (found != null)
        {
            service.RemoveUser("1");
        }
    }

    public static void RunWithValidation()
    {
        var repo = new UserRepository();
        var service = new UserService(repo);

        var user = new User { Id = "2", Name = "Bob", Email = "bob@example.com" };
        var isValid = Validators.ValidateUser(user);
        if (isValid)
        {
            service.AddUser(user);
        }
    }
}

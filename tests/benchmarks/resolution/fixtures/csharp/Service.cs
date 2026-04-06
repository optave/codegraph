using System;

namespace Benchmark;

public class UserService
{
    private readonly IRepository _repo;

    public UserService(IRepository repo)
    {
        _repo = repo;
    }

    public User GetUser(string id)
    {
        return _repo.FindById(id);
    }

    public bool AddUser(User user)
    {
        if (!Validators.ValidateUser(user))
        {
            return false;
        }
        _repo.Save(user);
        return true;
    }

    public bool RemoveUser(string id)
    {
        var existing = _repo.FindById(id);
        if (existing == null) return false;
        return _repo.Delete(id);
    }
}

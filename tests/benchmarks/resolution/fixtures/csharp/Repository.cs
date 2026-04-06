using System.Collections.Generic;

namespace Benchmark;

public interface IRepository
{
    User FindById(string id);
    void Save(User user);
    bool Delete(string id);
}

public class UserRepository : IRepository
{
    private readonly Dictionary<string, User> _store = new();

    public User FindById(string id)
    {
        _store.TryGetValue(id, out var user);
        return user;
    }

    public void Save(User user)
    {
        _store[user.Id] = user;
    }

    public bool Delete(string id)
    {
        return _store.Remove(id);
    }
}

public class User
{
    public string Id { get; set; }
    public string Name { get; set; }
    public string Email { get; set; }
}

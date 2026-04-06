package benchmark;

public class UserService extends BaseService {

    private final UserRepository repo;
    private final Validator validator;

    public UserService(UserRepository repo) {
        this.repo = repo;
        this.validator = new Validator();
    }

    public String getUser(String id) {
        log("getUser called with id=" + id);
        return repo.findById(id);
    }

    public void createUser(String id, String name, String email) {
        boolean valid = validator.validateUser(name, email);
        if (!valid) {
            throw new IllegalArgumentException("Invalid user data");
        }
        String data = name + ":" + email;
        repo.save(id, data);
        log("Created user " + id);
    }

    public boolean removeUser(String id) {
        log("removeUser called with id=" + id);
        return repo.delete(id);
    }

    public static UserService createDefault() {
        InMemoryUserRepository repo = new InMemoryUserRepository();
        return new UserService(repo);
    }
}

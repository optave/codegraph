package benchmark;

public interface UserRepository {
    String findById(String id);
    void save(String id, String data);
    boolean delete(String id);
}

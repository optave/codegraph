package benchmark;

import java.util.HashMap;
import java.util.Map;

public class InMemoryUserRepository implements UserRepository {

    private final Map<String, String> store = new HashMap<>();

    @Override
    public String findById(String id) {
        return store.get(id);
    }

    @Override
    public void save(String id, String data) {
        store.put(id, data);
    }

    @Override
    public boolean delete(String id) {
        return store.remove(id) != null;
    }
}

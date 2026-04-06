package benchmark;

public abstract class BaseService {

    protected void log(String message) {
        System.out.println("[LOG] " + message);
    }

    protected long timestamp() {
        return System.currentTimeMillis();
    }
}

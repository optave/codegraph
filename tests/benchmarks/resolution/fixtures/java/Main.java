package benchmark;

public class Main {

    public static void main(String[] args) {
        UserService service = UserService.createDefault();

        service.createUser("u1", "Alice", "alice@example.com");
        String user = service.getUser("u1");

        boolean valid = Validator.isValidEmail("alice@example.com");
        System.out.println("Email valid: " + valid);

        service.removeUser("u1");
    }
}

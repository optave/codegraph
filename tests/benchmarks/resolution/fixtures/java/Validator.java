package benchmark;

public class Validator {

    public static boolean isValidEmail(String email) {
        return email != null && email.contains("@");
    }

    public static boolean isNonEmpty(String value) {
        return value != null && !value.trim().isEmpty();
    }

    public boolean validateUser(String name, String email) {
        boolean nameOk = isNonEmpty(name);
        boolean emailOk = isValidEmail(email);
        return nameOk && emailOk;
    }
}

#include "validators.h"

bool check_length(const std::string& value, int min, int max) {
    return value.size() >= min && value.size() <= max;
}

bool validate_email(const std::string& email) {
    if (!check_length(email, 3, 254)) {
        return false;
    }
    return email.find('@') != std::string::npos;
}

bool validate_name(const std::string& name) {
    if (!check_length(name, 1, 100)) {
        return false;
    }
    return !name.empty();
}

#include "validators.h"
#include <string.h>

int valid_email(const char *email) {
    return strchr(email, '@') != NULL && strchr(email, '.') != NULL;
}

int valid_name(const char *name) {
    return name != NULL && strlen(name) >= 2;
}

int validate_user(const char *name, const char *email) {
    return valid_name(name) && valid_email(email);
}

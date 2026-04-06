#include "service.h"
#include "validators.h"
#include <stdio.h>

static void print_user(const User *user) {
    printf("User: %s (%s)\n", user->name, user->email);
}

int main(void) {
    init_store();

    if (valid_email("alice@example.com")) {
        User u;
        int rc = create_user(&u, "u1", "Alice", "alice@example.com");
        if (rc == 0) {
            print_user(&u);
        }
    }

    User *found = find_user("u1");
    if (found) {
        print_user(found);
    }

    remove_user("u1");
    return 0;
}

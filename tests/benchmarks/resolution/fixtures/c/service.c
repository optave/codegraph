#include "service.h"
#include "validators.h"
#include <string.h>
#include <stdlib.h>

#define MAX_USERS 100

static User store[MAX_USERS];
static int count = 0;

void init_store(void) {
    count = 0;
    memset(store, 0, sizeof(store));
}

int create_user(User *out, const char *id, const char *name, const char *email) {
    if (!validate_user(name, email)) {
        return -1;
    }
    if (count >= MAX_USERS) {
        return -2;
    }
    strncpy(store[count].id, id, sizeof(store[count].id) - 1);
    strncpy(store[count].name, name, sizeof(store[count].name) - 1);
    strncpy(store[count].email, email, sizeof(store[count].email) - 1);
    if (out) {
        *out = store[count];
    }
    count++;
    return 0;
}

User *find_user(const char *id) {
    for (int i = 0; i < count; i++) {
        if (strcmp(store[i].id, id) == 0) {
            return &store[i];
        }
    }
    return NULL;
}

int remove_user(const char *id) {
    for (int i = 0; i < count; i++) {
        if (strcmp(store[i].id, id) == 0) {
            store[i] = store[count - 1];
            count--;
            return 0;
        }
    }
    return -1;
}

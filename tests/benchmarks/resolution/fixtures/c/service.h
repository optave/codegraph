#ifndef SERVICE_H
#define SERVICE_H

typedef struct {
    char id[32];
    char name[64];
    char email[128];
} User;

int create_user(User *out, const char *id, const char *name, const char *email);
User *find_user(const char *id);
int remove_user(const char *id);
void init_store(void);

#endif

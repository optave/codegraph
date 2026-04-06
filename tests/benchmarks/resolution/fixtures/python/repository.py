from models import User


class UserRepository:
    def __init__(self):
        self._store = {}

    def find_by_id(self, user_id):
        return self._store.get(user_id)

    def save(self, user):
        self._store[user.user_id] = user

    def delete(self, user_id):
        return self._store.pop(user_id, None) is not None


def create_repository():
    return UserRepository()

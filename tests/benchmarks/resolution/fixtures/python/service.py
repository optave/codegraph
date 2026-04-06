from models import User
from repository import create_repository


def validate_email(email):
    return "@" in email and "." in email


class UserService:
    def __init__(self, repo):
        self.repo = repo

    def create_user(self, user_id, name, email):
        if not validate_email(email):
            raise ValueError("Invalid email")
        user = User(user_id, name, email)
        if not user.validate():
            raise ValueError("Invalid user data")
        self.repo.save(user)
        return user

    def get_user(self, user_id):
        return self.repo.find_by_id(user_id)

    def remove_user(self, user_id):
        return self.repo.delete(user_id)


def build_service():
    repo = create_repository()
    return UserService(repo)

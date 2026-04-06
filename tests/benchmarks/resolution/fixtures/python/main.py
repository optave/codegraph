from service import build_service, UserService
from models import Order


def run():
    svc = build_service()
    svc.create_user("u1", "Alice", "alice@example.com")
    user = svc.get_user("u1")
    if user:
        order = Order("o1", user.user_id, 42.0)
        order.validate()
    svc.remove_user("u1")


if __name__ == "__main__":
    run()

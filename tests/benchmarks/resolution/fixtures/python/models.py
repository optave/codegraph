class Entity:
    """Base class for all domain entities."""

    def validate(self):
        """Override in subclasses to add validation logic."""
        return True


class User(Entity):
    def __init__(self, user_id, name, email):
        self.user_id = user_id
        self.name = name
        self.email = email

    def validate(self):
        return bool(self.name) and "@" in self.email


class Order(Entity):
    def __init__(self, order_id, user_id, total):
        self.order_id = order_id
        self.user_id = user_id
        self.total = total

    def validate(self):
        return self.total > 0

class User {
  final String id;
  final String name;
  final String email;

  User(this.id, this.name, this.email);

  @override
  String toString() => '$name <$email>';
}

class Order {
  final String id;
  final String userId;
  final double amount;

  Order(this.id, this.userId, this.amount);

  @override
  String toString() => 'Order($id, \$$amount)';
}

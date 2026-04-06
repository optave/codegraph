import 'models.dart';
import 'repository.dart';
import 'service.dart';
import 'validators.dart';

void main() {
  var repo = UserRepository();
  var svc = UserService(repo);

  if (!validateEmail('alice@example.com')) {
    print('invalid email');
    return;
  }

  var alice = svc.createUser('1', 'Alice', 'alice@example.com');
  svc.createUser('2', 'Bob', 'bob@example.com');

  var user = svc.getUser('1');
  if (user != null) {
    print('found: $user');
  }

  svc.removeUser('2');
  print(svc.summary());

  var order = Order('o1', '1', 29.99);
  if (validateAmount(order.amount)) {
    print('order valid: $order');
  }
}

import 'models.dart';

class UserRepository {
  final Map<String, User> _users = {};

  void save(User user) {
    _users[user.id] = user;
  }

  User? findById(String id) {
    return _users[id];
  }

  bool delete(String id) {
    return _users.remove(id) != null;
  }

  int count() {
    return _users.length;
  }
}

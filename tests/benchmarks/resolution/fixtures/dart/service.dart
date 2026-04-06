import 'models.dart';
import 'repository.dart';
import 'validators.dart';

class UserService {
  final UserRepository _repo;

  UserService(this._repo);

  User? createUser(String id, String name, String email) {
    if (!validateName(name)) return null;
    if (!validateEmail(email)) return null;
    var user = User(id, name, email);
    _repo.save(user);
    return user;
  }

  User? getUser(String id) {
    return _repo.findById(id);
  }

  bool removeUser(String id) {
    return _repo.delete(id);
  }

  String summary() {
    var total = _repo.count();
    return 'repository contains $total users';
  }
}

// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

contract UserRepository {
    struct User {
        string id;
        string name;
        string email;
        bool exists;
    }

    mapping(string => User) private users;
    string[] private userIds;

    function save(string memory id, string memory name, string memory email) public returns (bool) {
        users[id] = User(id, name, email, true);
        userIds.push(id);
        return true;
    }

    function findById(string memory id) public view returns (string memory, string memory, string memory) {
        require(users[id].exists, "User not found");
        User memory u = users[id];
        return (u.id, u.name, u.email);
    }

    function remove(string memory id) public returns (bool) {
        require(users[id].exists, "User not found");
        delete users[id];
        return true;
    }

    function count() public view returns (uint256) {
        return userIds.length;
    }
}

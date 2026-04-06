// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "./Repository.sol";
import "./Validators.sol";

contract UserService {
    UserRepository private repo;

    constructor(UserRepository _repo) {
        repo = _repo;
    }

    function createUser(string memory id, string memory name, string memory email) public returns (bool) {
        Validators.validateUserInput(name, email);
        repo.save(id, name, email);
        return true;
    }

    function getUser(string memory id) public view returns (string memory, string memory, string memory) {
        return repo.findById(id);
    }

    function removeUser(string memory id) public returns (bool) {
        repo.findById(id);
        return repo.remove(id);
    }
}

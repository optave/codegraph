// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "./Service.sol";
import "./Repository.sol";

contract Main {
    UserService private service;
    UserRepository private repo;

    constructor() {
        repo = new UserRepository();
        service = new UserService(repo);
    }

    function run() public {
        service.createUser("u1", "Alice", "alice@example.com");
        service.getUser("u1");
        service.removeUser("u1");
        repo.count();
    }
}

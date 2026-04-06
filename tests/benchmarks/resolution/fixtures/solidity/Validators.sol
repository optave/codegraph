// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

library Validators {
    function validateEmail(string memory email) internal pure returns (bool) {
        bytes memory b = bytes(email);
        require(b.length > 3, "Email too short");
        return true;
    }

    function validateName(string memory name) internal pure returns (bool) {
        bytes memory b = bytes(name);
        require(b.length >= 2, "Name too short");
        return true;
    }

    function validateUserInput(string memory name, string memory email) internal pure returns (bool) {
        validateName(name);
        validateEmail(email);
        return true;
    }
}

<?php

require_once __DIR__ . '/Repository.php';
require_once __DIR__ . '/Service.php';
require_once __DIR__ . '/Validators.php';

function main(): void
{
    $repo = new UserRepository();
    $service = new UserService($repo);

    $user = new User('1', 'Alice', 'alice@example.com');

    if (Validators::isValidEmail($user->email)) {
        $service->addUser($user);
    }

    $found = $service->getUser('1');
    if ($found !== null) {
        $service->removeUser('1');
    }
}

function runWithValidation(): void
{
    $repo = new UserRepository();
    $service = new UserService($repo);

    $user = new User('2', 'Bob', 'bob@example.com');
    $isValid = Validators::validateUser($user);
    if ($isValid) {
        $service->addUser($user);
    }
}

main();

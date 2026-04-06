<?php

require_once __DIR__ . '/Repository.php';
require_once __DIR__ . '/Validators.php';

class UserService
{
    private UserRepository $repo;

    public function __construct(UserRepository $repo)
    {
        $this->repo = $repo;
    }

    public function getUser(string $id): ?User
    {
        return $this->repo->findById($id);
    }

    public function addUser(User $user): bool
    {
        if (!Validators::validateUser($user)) {
            return false;
        }
        $this->repo->save($user);
        return true;
    }

    public function removeUser(string $id): bool
    {
        $existing = $this->repo->findById($id);
        if ($existing === null) {
            return false;
        }
        return $this->repo->delete($id);
    }
}

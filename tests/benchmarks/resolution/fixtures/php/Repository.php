<?php

class User
{
    public string $id;
    public string $name;
    public string $email;

    public function __construct(string $id, string $name, string $email)
    {
        $this->id = $id;
        $this->name = $name;
        $this->email = $email;
    }
}

class UserRepository
{
    private array $store = [];

    public function findById(string $id): ?User
    {
        return $this->store[$id] ?? null;
    }

    public function save(User $user): void
    {
        $this->store[$user->id] = $user;
    }

    public function delete(string $id): bool
    {
        if (isset($this->store[$id])) {
            unset($this->store[$id]);
            return true;
        }
        return false;
    }
}

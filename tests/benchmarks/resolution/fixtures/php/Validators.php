<?php

class Validators
{
    public static function isValidEmail(string $email): bool
    {
        return str_contains($email, '@');
    }

    public static function isValidName(string $name): bool
    {
        return strlen($name) >= 2;
    }

    public static function validateUser(User $user): bool
    {
        return self::isValidEmail($user->email) && self::isValidName($user->name);
    }
}

module Validators

let validateEmail (email: string) =
    email.Contains("@") && email.Contains(".")

let validateName (name: string) =
    name.Length >= 2 && name.Length <= 50

let validateAge (age: int) =
    age >= 0 && age <= 150

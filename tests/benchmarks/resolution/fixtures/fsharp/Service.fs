module Service

let validateUser name email age =
    Validators.validateName name
    && Validators.validateEmail email
    && Validators.validateAge age

let createUser uid name email age =
    if validateUser name email age then
        Repository.save uid { Repository.Name = name; Repository.Email = email; Repository.Age = age }
        Ok ()
    else
        Error "Validation failed"

let getUser uid =
    Repository.findById uid

let removeUser uid =
    Repository.delete uid

let summary () =
    Repository.count ()

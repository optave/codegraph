let validate_user name email age =
  Validators.validate_name name
  && Validators.validate_email email
  && Validators.validate_age age

let create_user uid name email age =
  if validate_user name email age then begin
    Repository.save uid { Repository.name; email; age };
    Ok ()
  end else
    Error "Validation failed"

let get_user uid =
  Repository.find_by_id uid

let remove_user uid =
  Repository.delete uid

let summary () =
  Repository.count ()

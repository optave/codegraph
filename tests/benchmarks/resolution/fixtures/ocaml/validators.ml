let validate_email email =
  String.contains email '@' && String.contains email '.'

let validate_name name =
  let len = String.length name in
  len >= 2 && len <= 50

let validate_age age =
  age >= 0 && age <= 150

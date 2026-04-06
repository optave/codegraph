type user_record = {
  name : string;
  email : string;
  age : int;
}

let store : (string, user_record) Hashtbl.t = Hashtbl.create 16

let save uid record =
  Hashtbl.replace store uid record

let find_by_id uid =
  Hashtbl.find_opt store uid

let delete uid =
  Hashtbl.remove store uid

let count () =
  Hashtbl.length store

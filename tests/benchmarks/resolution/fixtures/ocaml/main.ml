let () =
  match Service.create_user "u1" "Alice" "alice@example.com" 30 with
  | Error msg -> Printf.printf "Error: %s\n" msg
  | Ok () ->
    let user = Service.get_user "u1" in
    (match user with
     | None -> print_endline "User not found"
     | Some u -> Printf.printf "Found user: %s\n" u.Repository.name);
    let total = Service.summary () in
    Printf.printf "Total users: %d\n" total;
    Service.remove_user "u1";
    Printf.printf "After removal: %d\n" (Service.summary ())

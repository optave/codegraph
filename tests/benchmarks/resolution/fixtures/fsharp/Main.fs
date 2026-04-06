module Main

[<EntryPoint>]
let main _argv =
    match Service.createUser "u1" "Alice" "alice@example.com" 30 with
    | Error msg -> printfn "Error: %s" msg
    | Ok () ->
        let user = Service.getUser "u1"
        match user with
        | None -> printfn "User not found"
        | Some u -> printfn "Found user: %s" u.Repository.Name
        let total = Service.summary ()
        printfn "Total users: %d" total
        Service.removeUser "u1"
        printfn "After removal: %d" (Service.summary ())
    0

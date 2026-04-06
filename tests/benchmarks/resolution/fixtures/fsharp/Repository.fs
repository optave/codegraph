module Repository

open System.Collections.Generic

type UserRecord = { Name: string; Email: string; Age: int }

let private store = Dictionary<string, UserRecord>()

let save (uid: string) (record: UserRecord) =
    store.[uid] <- record

let findById (uid: string) =
    match store.TryGetValue(uid) with
    | true, record -> Some record
    | _ -> None

let delete (uid: string) =
    store.Remove(uid) |> ignore

let count () =
    store.Count

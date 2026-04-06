-module(repository).
-export([init/0, save/2, find_by_id/2, delete/2, list_all/1]).

init() ->
    ets:new(user_store, [set, named_table, public]).

save(User, Table) ->
    Id = maps:get(id, User),
    ets:insert(Table, {Id, User}),
    User.

find_by_id(Id, Table) ->
    case ets:lookup(Table, Id) of
        [{_, User}] -> {ok, User};
        [] -> {error, not_found}
    end.

delete(Id, Table) ->
    ets:delete(Table, Id),
    ok.

list_all(Table) ->
    ets:tab2list(Table).

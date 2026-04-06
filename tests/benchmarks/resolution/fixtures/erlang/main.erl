-module(main).
-export([run/0]).

run() ->
    Table = repository:init(),
    User = service:create_user("u1", "Alice", "alice@example.com", Table),
    io:format("Created: ~p~n", [User]),
    Found = service:get_user("u1", Table),
    io:format("Found: ~p~n", [Found]),
    service:remove_user("u1", Table),
    All = repository:list_all(Table),
    io:format("All: ~p~n", [All]).

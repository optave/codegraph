-module(service).
-export([create_user/4, get_user/2, remove_user/2]).

create_user(Id, Name, Email, Table) ->
    case validators:validate_user_input(Name, Email) of
        ok ->
            User = #{id => Id, name => Name, email => Email},
            repository:save(User, Table);
        Error ->
            Error
    end.

get_user(Id, Table) ->
    repository:find_by_id(Id, Table).

remove_user(Id, Table) ->
    case repository:find_by_id(Id, Table) of
        {ok, _} ->
            repository:delete(Id, Table);
        Error ->
            Error
    end.

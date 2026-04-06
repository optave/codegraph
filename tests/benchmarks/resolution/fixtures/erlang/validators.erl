-module(validators).
-export([validate_email/1, validate_name/1, validate_user_input/2]).

validate_email(Email) ->
    case string:find(Email, "@") of
        nomatch -> {error, invalid_email};
        _ -> ok
    end.

validate_name(Name) ->
    case string:length(Name) >= 2 of
        true -> ok;
        false -> {error, name_too_short}
    end.

validate_user_input(Name, Email) ->
    case validate_name(Name) of
        ok ->
            validate_email(Email);
        Error ->
            Error
    end.

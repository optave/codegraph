module Validators

function validate_name(name)
    if isempty(name)
        return false
    end
    check_length(name, 1, 100)
end

function validate_email(email)
    if isempty(email)
        return false
    end
    contains_at(email)
end

function check_length(value, min_len, max_len)
    len = length(value)
    len >= min_len && len <= max_len
end

function contains_at(email)
    occursin("@", email)
end

end # module Validators

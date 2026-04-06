local M = {}

local function check_not_empty(value)
    return value ~= nil and value ~= ""
end

function M.validate_name(name)
    if not check_not_empty(name) then
        return false, "name must not be empty"
    end
    if #name < 2 then
        return false, "name must be at least 2 characters"
    end
    return true, nil
end

function M.validate_email(email)
    if not check_not_empty(email) then
        return false, "email must not be empty"
    end
    if not string.find(email, "@") then
        return false, "email must contain @"
    end
    return true, nil
end

return M

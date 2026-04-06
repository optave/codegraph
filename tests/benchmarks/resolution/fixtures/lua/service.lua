local repository = require("repository")
local validators = require("validators")

local M = {}

function M.create_user(id, name, email)
    local valid, err = validators.validate_name(name)
    if not valid then
        return nil, err
    end
    valid, err = validators.validate_email(email)
    if not valid then
        return nil, err
    end
    local user = { id = id, name = name, email = email }
    repository.save(user)
    return user, nil
end

function M.get_user(id)
    return repository.find_by_id(id)
end

function M.remove_user(id)
    return repository.delete(id)
end

function M.summary()
    local count = repository.count()
    return string.format("repository contains %d users", count)
end

return M

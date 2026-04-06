local M = {}

local users = {}

function M.save(user)
    users[user.id] = user
end

function M.find_by_id(id)
    return users[id]
end

function M.delete(id)
    if users[id] then
        users[id] = nil
        return true
    end
    return false
end

function M.count()
    local n = 0
    for _ in pairs(users) do
        n = n + 1
    end
    return n
end

return M

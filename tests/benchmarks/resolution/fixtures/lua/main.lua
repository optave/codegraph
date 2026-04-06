local service = require("service")
local validators = require("validators")

local function main()
    local valid, err = validators.validate_email("alice@example.com")
    if not valid then
        print("invalid email: " .. err)
        return
    end

    service.create_user("1", "Alice", "alice@example.com")
    service.create_user("2", "Bob", "bob@example.com")

    local user = service.get_user("1")
    if user then
        print("found: " .. user.name .. " <" .. user.email .. ">")
    end

    service.remove_user("2")
    print(service.summary())
end

main()

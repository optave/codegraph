module Service

using ..Repository
using ..Validators

function create_user(repo, name, email)
    valid_name = Validators.validate_name(name)
    valid_email = Validators.validate_email(email)
    if valid_name && valid_email
        Repository.save(repo, name, email)
    else
        error("validation failed")
    end
end

function get_user(repo, id)
    Repository.find_by_id(repo, id)
end

function remove_user(repo, id)
    Repository.delete(repo, id)
end

function summary(repo)
    cnt = Repository.count(repo)
    format_summary(cnt)
end

function format_summary(cnt)
    "repository contains $cnt users"
end

end # module Service

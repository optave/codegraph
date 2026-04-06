module Repository

function new_repo()
    Dict{String, Tuple{String, String}}()
end

function save(repo, name, email)
    repo[name] = (name, email)
    :ok
end

function find_by_id(repo, id)
    if haskey(repo, id)
        repo[id]
    else
        error("not found")
    end
end

function delete(repo, id)
    if haskey(repo, id)
        delete!(repo, id)
        :ok
    else
        error("not found")
    end
end

function count(repo)
    count_entries(repo)
end

function count_entries(repo)
    length(repo)
end

end # module Repository

module App

include("repository.jl")
include("validators.jl")
include("service.jl")

using .Repository
using .Validators
using .Service

function main()
    repo = Repository.new_repo()
    result = Service.create_user(repo, "alice", "alice@example.com")
    user = Service.get_user(repo, "alice")
    removed = Service.remove_user(repo, "alice")
    summary = Service.summary(repo)
    println(summary)
end

end # module App

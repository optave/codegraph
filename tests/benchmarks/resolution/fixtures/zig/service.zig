const repo_mod = @import("repository.zig");
const validators = @import("validators.zig");

const User = repo_mod.User;
const UserRepository = repo_mod.UserRepository;

pub const UserService = struct {
    repo: *UserRepository,

    pub fn init(repo: *UserRepository) UserService {
        return UserService{ .repo = repo };
    }

    pub fn createUser(self: *UserService, id: []const u8, name: []const u8, email: []const u8) ?User {
        if (!validators.validateName(name)) return null;
        if (!validators.validateEmail(email)) return null;
        const user = User{ .id = id, .name = name, .email = email };
        self.repo.save(user);
        return user;
    }

    pub fn getUser(self: *UserService, id: []const u8) ?User {
        return self.repo.findById(id);
    }

    pub fn removeUser(self: *UserService, id: []const u8) bool {
        return self.repo.delete(id);
    }

    pub fn summary(self: *UserService) usize {
        return self.repo.count();
    }
};

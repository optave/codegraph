const std = @import("std");

pub const User = struct {
    id: []const u8,
    name: []const u8,
    email: []const u8,
};

pub const UserRepository = struct {
    users: std.StringHashMap(User),

    pub fn init(allocator: std.mem.Allocator) UserRepository {
        return UserRepository{
            .users = std.StringHashMap(User).init(allocator),
        };
    }

    pub fn save(self: *UserRepository, user: User) void {
        self.users.put(user.id, user) catch {};
    }

    pub fn findById(self: *UserRepository, id: []const u8) ?User {
        return self.users.get(id);
    }

    pub fn delete(self: *UserRepository, id: []const u8) bool {
        if (self.users.fetchRemove(id)) |_| {
            return true;
        }
        return false;
    }

    pub fn count(self: *UserRepository) usize {
        return self.users.count();
    }
};

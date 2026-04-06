const std = @import("std");
const repo_mod = @import("repository.zig");
const svc_mod = @import("service.zig");
const validators = @import("validators.zig");

const UserRepository = repo_mod.UserRepository;
const UserService = svc_mod.UserService;

pub fn main() !void {
    var gpa = std.heap.GeneralPurposeAllocator(.{}){};
    const allocator = gpa.allocator();

    var repo = UserRepository.init(allocator);
    var svc = UserService.init(&repo);

    if (!validators.validateEmail("alice@example.com")) {
        std.debug.print("invalid email\n", .{});
        return;
    }

    _ = svc.createUser("1", "Alice", "alice@example.com");
    _ = svc.createUser("2", "Bob", "bob@example.com");

    if (svc.getUser("1")) |user| {
        std.debug.print("found: {s} <{s}>\n", .{ user.name, user.email });
    }

    _ = svc.removeUser("2");

    const total = svc.summary();
    std.debug.print("repository contains {} users\n", .{total});
}

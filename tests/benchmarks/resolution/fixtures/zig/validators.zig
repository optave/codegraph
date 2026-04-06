const std = @import("std");

fn isNotEmpty(value: []const u8) bool {
    return value.len > 0;
}

pub fn validateName(name: []const u8) bool {
    if (!isNotEmpty(name)) return false;
    return name.len >= 2;
}

pub fn validateEmail(email: []const u8) bool {
    if (!isNotEmpty(email)) return false;
    for (email) |c| {
        if (c == '@') return true;
    }
    return false;
}

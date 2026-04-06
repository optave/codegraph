#pragma once

#include <string>

bool validate_email(const std::string& email);
bool validate_name(const std::string& name);
bool check_length(const std::string& value, int min, int max);

#!/usr/bin/env bash

valid_email() {
  local email="$1"
  [[ "$email" == *@*.* ]]
}

valid_name() {
  local name="$1"
  [[ ${#name} -ge 2 ]]
}

validate_user() {
  local name="$1"
  local email="$2"
  valid_name "$name" && valid_email "$email"
}

#!/usr/bin/env bash

source "$(dirname "$0")/service.sh"

run() {
  create_user "u1" "Alice" "alice@example.com"
  local found
  found=$(get_user "u1")
  if [[ -n "$found" ]]; then
    echo "Found: $found"
  fi
  list_users
  remove_user "u1"
}

run

#!/usr/bin/env bash

source "$(dirname "$0")/validators.sh"
source "$(dirname "$0")/repository.sh"

format_user() {
  local id="$1"
  local name="$2"
  local email="$3"
  echo "${id}:${name}:${email}"
}

create_user() {
  local id="$1"
  local name="$2"
  local email="$3"
  if ! validate_user "$name" "$email"; then
    echo "Invalid user data" >&2
    return 1
  fi
  local data
  data=$(format_user "$id" "$name" "$email")
  repo_save "$id" "$data"
}

get_user() {
  local id="$1"
  repo_find_by_id "$id"
}

remove_user() {
  local id="$1"
  repo_delete "$id"
}

list_users() {
  repo_list_all
}

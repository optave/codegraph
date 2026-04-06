#!/usr/bin/env bash

declare -A STORE

repo_save() {
  local id="$1"
  local data="$2"
  STORE["$id"]="$data"
}

repo_find_by_id() {
  local id="$1"
  echo "${STORE[$id]}"
}

repo_delete() {
  local id="$1"
  unset STORE["$id"]
}

repo_list_all() {
  for key in "${!STORE[@]}"; do
    echo "${STORE[$key]}"
  done
}

def repo_find_by_id(store, id)
  store[id]
end

def repo_save(store, id, entity)
  store[id] = entity
end

def repo_delete(store, id)
  store.delete(id)
end

def repo_find_by_email(store, email)
  store.values.find { |u| u[:email] == email }
end

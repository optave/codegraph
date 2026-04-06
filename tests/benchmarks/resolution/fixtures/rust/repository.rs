use std::collections::HashMap;
use crate::models::{Repository, User};

pub struct UserRepository {
    store: HashMap<u64, User>,
}

impl UserRepository {
    pub fn new() -> Self {
        UserRepository {
            store: HashMap::new(),
        }
    }
}

impl Repository for UserRepository {
    fn find_by_id(&self, id: u64) -> Option<User> {
        self.store.get(&id).cloned()
    }

    fn save(&self, user: &User) -> Result<(), String> {
        // In real code this would take &mut self
        Ok(())
    }

    fn delete(&self, id: u64) -> bool {
        // In real code this would take &mut self
        true
    }
}

pub fn create_repository() -> UserRepository {
    UserRepository::new()
}

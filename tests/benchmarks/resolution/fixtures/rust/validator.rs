use crate::models::{User, Validator};

pub struct EmailValidator;

impl EmailValidator {
    pub fn new() -> Self {
        EmailValidator
    }
}

impl Validator for EmailValidator {
    fn validate(&self, user: &User) -> Result<(), String> {
        if is_valid_email(&user.email) {
            Ok(())
        } else {
            Err(format!("Invalid email: {}", user.email))
        }
    }
}

fn is_valid_email(email: &str) -> bool {
    email.contains('@') && email.contains('.')
}

pub struct NameValidator;

impl Validator for NameValidator {
    fn validate(&self, user: &User) -> Result<(), String> {
        if user.name.is_empty() {
            Err("Name cannot be empty".to_string())
        } else {
            Ok(())
        }
    }
}

pub fn validate_all(user: &User) -> Result<(), String> {
    let email_v = EmailValidator::new();
    email_v.validate(user)?;
    let name_v = NameValidator;
    name_v.validate(user)?;
    Ok(())
}

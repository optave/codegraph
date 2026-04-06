module Validators
  ( validateEmail
  , validateName
  , validateAge
  ) where

validateEmail :: String -> Bool
validateEmail email = '@' `elem` email && '.' `elem` email

validateName :: String -> Bool
validateName name = length name >= 2 && length name <= 50

validateAge :: Int -> Bool
validateAge age = age >= 0 && age <= 150

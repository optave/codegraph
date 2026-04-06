module Service
  ( createUser
  , getUser
  , removeUser
  , summary
  ) where

import qualified Repository as Repo
import Validators (validateEmail, validateName, validateAge)
import Data.Map.Strict (Map)

type UserId = String
type UserRecord = (String, String, Int)
type Store = Map UserId UserRecord

validateUser :: String -> String -> Int -> Bool
validateUser name email age =
  validateName name && validateEmail email && validateAge age

createUser :: UserId -> String -> String -> Int -> Store -> Either String Store
createUser uid name email age store =
  if validateUser name email age
    then Right (Repo.save uid (name, email, age) store)
    else Left "Validation failed"

getUser :: UserId -> Store -> Maybe UserRecord
getUser uid store = Repo.findById uid store

removeUser :: UserId -> Store -> Store
removeUser uid store = Repo.delete uid store

summary :: Store -> Int
summary store = Repo.count store

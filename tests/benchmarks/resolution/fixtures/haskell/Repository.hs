module Repository
  ( save
  , findById
  , delete
  , count
  ) where

import Data.Map.Strict (Map)
import qualified Data.Map.Strict as Map

type UserId = String
type UserRecord = (String, String, Int)

save :: UserId -> UserRecord -> Map UserId UserRecord -> Map UserId UserRecord
save uid record store = Map.insert uid record store

findById :: UserId -> Map UserId UserRecord -> Maybe UserRecord
findById uid store = Map.lookup uid store

delete :: UserId -> Map UserId UserRecord -> Map UserId UserRecord
delete uid store = Map.delete uid store

count :: Map UserId UserRecord -> Int
count store = Map.size store

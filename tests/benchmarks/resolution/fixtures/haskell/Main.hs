module Main where

import qualified Data.Map.Strict as Map
import Service (createUser, getUser, removeUser, summary)

main :: IO ()
main = do
  let store = Map.empty
  case createUser "u1" "Alice" "alice@example.com" 30 store of
    Left err -> putStrLn ("Error: " ++ err)
    Right store1 -> do
      let user = getUser "u1" store1
      putStrLn ("Found user: " ++ show user)
      let total = summary store1
      putStrLn ("Total users: " ++ show total)
      let store2 = removeUser "u1" store1
      putStrLn ("After removal: " ++ show (summary store2))

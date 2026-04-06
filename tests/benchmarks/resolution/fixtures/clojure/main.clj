(ns app.main
  (:require [app.service :as service]
            [app.repository :as repository]))

(defn run []
  (let [repo (repository/new-repo)
        result (service/create-user repo "alice" "alice@example.com")
        user (service/get-user repo "alice")
        removed (service/remove-user repo "alice")
        summary (service/summary repo)]
    summary))

(defn -main [& args]
  (println (run)))

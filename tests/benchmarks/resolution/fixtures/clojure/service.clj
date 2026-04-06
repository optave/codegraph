(ns app.service
  (:require [app.repository :as repository]
            [app.validators :as validators]))

(defn create-user [repo name email]
  (let [valid-name (validators/validate-name name)
        valid-email (validators/validate-email email)]
    (if (and valid-name valid-email)
      (repository/save repo name email)
      {:error "validation failed"})))

(defn get-user [repo id]
  (repository/find-by-id repo id))

(defn remove-user [repo id]
  (repository/delete repo id))

(defn summary [repo]
  (let [cnt (repository/count repo)]
    (format-summary cnt)))

(defn- format-summary [cnt]
  (str "repository contains " cnt " users"))

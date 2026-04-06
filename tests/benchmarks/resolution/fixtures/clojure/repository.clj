(ns app.repository)

(defn new-repo []
  (atom {}))

(defn save [repo name email]
  (swap! repo assoc name {:name name :email email})
  :ok)

(defn find-by-id [repo id]
  (get @repo id))

(defn delete [repo id]
  (if (contains? @repo id)
    (do (swap! repo dissoc id) :ok)
    {:error "not found"}))

(defn count [repo]
  (count-entries @repo))

(defn- count-entries [data]
  (clojure.core/count data))

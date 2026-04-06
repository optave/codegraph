(ns app.validators)

(defn validate-name [name]
  (and (not (empty? name))
       (check-length name 1 100)))

(defn validate-email [email]
  (and (not (empty? email))
       (contains-at email)))

(defn- check-length [value min-len max-len]
  (let [len (clojure.core/count value)]
    (and (>= len min-len) (<= len max-len))))

(defn- contains-at [email]
  (clojure.string/includes? email "@"))

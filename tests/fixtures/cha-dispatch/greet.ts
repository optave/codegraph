// A free function that happens to share its name with IGreeter's own method
// (issue #2139). NameCollisionDispatcher.ts imports this alongside the
// interface-typed dispatch below — the import-aware resolution tier matches
// call.name ("greet") regardless of receiver, so this file's mere presence
// is what makes the collision reachable.
export function greet(): string {
  return 'anonymous';
}

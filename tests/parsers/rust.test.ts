import { beforeAll, describe, expect, it } from 'vitest';
import { createParsers, extractRustSymbols } from '../../src/domain/parser.js';

describe('Rust parser', () => {
  let parsers: any;

  beforeAll(async () => {
    parsers = await createParsers();
  });

  function parseRust(code) {
    const parser = parsers.get('rust');
    if (!parser) throw new Error('Rust parser not available');
    const tree = parser.parse(code);
    return extractRustSymbols(tree, 'test.rs');
  }

  it('extracts function declarations', () => {
    const symbols = parseRust(`fn greet(name: &str) -> String { format!("hello {}", name) }`);
    expect(symbols.definitions).toContainEqual(
      expect.objectContaining({ name: 'greet', kind: 'function', line: 1 }),
    );
  });

  it('extracts struct declarations', () => {
    const symbols = parseRust(`struct User { name: String, age: u32 }`);
    expect(symbols.definitions).toContainEqual(
      expect.objectContaining({ name: 'User', kind: 'struct' }),
    );
  });

  it('extracts enum declarations', () => {
    const symbols = parseRust(`enum Color { Red, Green, Blue }`);
    expect(symbols.definitions).toContainEqual(
      expect.objectContaining({ name: 'Color', kind: 'enum' }),
    );
  });

  it('extracts trait declarations', () => {
    const symbols = parseRust(`trait Drawable { fn draw(&self); fn area(&self) -> f64; }`);
    expect(symbols.definitions).toContainEqual(
      expect.objectContaining({ name: 'Drawable', kind: 'trait' }),
    );
    expect(symbols.definitions).toContainEqual(
      expect.objectContaining({ name: 'Drawable.draw', kind: 'method' }),
    );
    expect(symbols.definitions).toContainEqual(
      expect.objectContaining({ name: 'Drawable.area', kind: 'method' }),
    );
  });

  it('extracts impl methods', () => {
    const symbols = parseRust(`
struct Server {}
impl Server {
    fn new() -> Self { Server {} }
    fn start(&self) {}
}`);
    expect(symbols.definitions).toContainEqual(
      expect.objectContaining({ name: 'Server.new', kind: 'method' }),
    );
    expect(symbols.definitions).toContainEqual(
      expect.objectContaining({ name: 'Server.start', kind: 'method' }),
    );
  });

  it('extracts trait impl as implements edge', () => {
    const symbols = parseRust(`
trait Display {}
struct Foo {}
impl Display for Foo {}`);
    expect(symbols.classes).toContainEqual(
      expect.objectContaining({ name: 'Foo', implements: 'Display' }),
    );
  });

  it('extracts use declarations', () => {
    const symbols = parseRust(`use std::io::Read;`);
    expect(symbols.imports).toContainEqual(
      expect.objectContaining({ source: 'std::io::Read', names: ['Read'] }),
    );
  });

  it('extracts grouped use declarations', () => {
    const symbols = parseRust(`use std::collections::{HashMap, HashSet};`);
    expect(symbols.imports).toContainEqual(
      expect.objectContaining({
        source: 'std::collections',
        names: expect.arrayContaining(['HashMap', 'HashSet']),
      }),
    );
  });

  it('extracts call expressions', () => {
    const symbols = parseRust(`fn main() { let v = Vec::new(); v.push(1); greet("hi"); }`);
    expect(symbols.calls).toContainEqual(expect.objectContaining({ name: 'new' }));
    expect(symbols.calls).toContainEqual(expect.objectContaining({ name: 'push' }));
    expect(symbols.calls).toContainEqual(expect.objectContaining({ name: 'greet' }));
  });

  it('extracts macro invocations', () => {
    const symbols = parseRust(`fn main() { println!("hello"); vec![1, 2, 3]; }`);
    const macros = symbols.calls.filter((c) => c.name.endsWith('!'));
    expect(macros.length).toBeGreaterThanOrEqual(1);
    expect(macros).toContainEqual(expect.objectContaining({ name: 'println!' }));
  });

  // ── #1876: receiver-typed locals + self.field type map ────────────────────

  it('seeds struct field type map for self.field resolution', () => {
    const symbols = parseRust(`struct UserService { repo: UserRepository }`);
    expect(symbols.typeMap?.get('UserService.repo')).toEqual(
      expect.objectContaining({ type: 'UserRepository' }),
    );
  });

  it('types a unit-struct value assignment (let v = TypeName;)', () => {
    const symbols = parseRust(`struct NameValidator;\nfn f() { let v = NameValidator; }`);
    expect(symbols.typeMap?.get('v')).toEqual(expect.objectContaining({ type: 'NameValidator' }));
  });

  it('does not type a unit enum variant as a unit struct (Greptile review)', () => {
    // `None` (Option::None) parses identically to a unit-struct reference — a bare
    // capitalized identifier — but is an enum variant, not a struct. Without a
    // same-file `struct` definition for the name, it must not be typed.
    const symbols = parseRust(`fn f() { let x = None; }`);
    expect(symbols.typeMap?.has('x')).toBe(false);
  });

  it('does not type a lowercase bare identifier assignment', () => {
    const symbols = parseRust(`fn f() { let a = 1; let b = a; }`);
    expect(symbols.typeMap?.has('b')).toBe(false);
  });

  it('stores the declared return type for a free function', () => {
    const symbols = parseRust(`fn build_service() -> UserService { todo!() }`);
    expect(symbols.returnTypeMap?.get('build_service')).toEqual(
      expect.objectContaining({ type: 'UserService', confidence: 1.0 }),
    );
  });

  it('resolves -> Self to the enclosing impl type', () => {
    const symbols = parseRust(
      `struct UserRepository;\nimpl UserRepository {\n  fn new() -> Self { UserRepository }\n}`,
    );
    expect(symbols.returnTypeMap?.get('UserRepository.new')).toEqual(
      expect.objectContaining({ type: 'UserRepository' }),
    );
  });

  it('records a call assignment for a bare function call', () => {
    const symbols = parseRust(`fn f() { let service = build_service(); }`);
    expect(symbols.callAssignments).toContainEqual(
      expect.objectContaining({ varName: 'service', calleeName: 'build_service' }),
    );
  });

  it('records a call assignment for an associated-function call', () => {
    const symbols = parseRust(`fn f() { let repo = UserRepository::new(); }`);
    expect(symbols.callAssignments).toContainEqual(
      expect.objectContaining({
        varName: 'repo',
        calleeName: 'new',
        receiverTypeName: 'UserRepository',
      }),
    );
  });

  it('records a call assignment for a method call on a locally-typed receiver', () => {
    const symbols = parseRust(
      `fn f() {\n  let repo: UserRepository = make();\n  let user = repo.find_by_id(1);\n}`,
    );
    expect(symbols.callAssignments).toContainEqual(
      expect.objectContaining({
        varName: 'user',
        calleeName: 'find_by_id',
        receiverTypeName: 'UserRepository',
      }),
    );
  });

  // ── if-let/while-let pattern-binding call assignments (#2214) ────────────

  it('records a call assignment for an if-let Some-bound method call', () => {
    const symbols = parseRust(
      `fn f() {\n  let service = build_service();\n  if let Some(user) = service.get_user(1) {}\n}`,
    );
    const ca = symbols.callAssignments.find((c) => c.varName === 'user');
    expect(ca).toEqual(
      expect.objectContaining({
        calleeName: 'get_user',
        receiverTypeName: undefined,
        receiverVarName: 'service',
        unwrapDepth: 1,
      }),
    );
  });

  it('records a call assignment for an if-let Ok-bound bare call', () => {
    const symbols = parseRust(`fn f() {\n  if let Ok(user) = build_user() {}\n}`);
    const ca = symbols.callAssignments.find((c) => c.varName === 'user');
    expect(ca).toEqual(expect.objectContaining({ calleeName: 'build_user', unwrapDepth: 1 }));
  });

  it('unwraps a while-let Some-bound call assignment too', () => {
    const symbols = parseRust(`fn f() {\n  while let Some(item) = next_item() {}\n}`);
    const ca = symbols.callAssignments.find((c) => c.varName === 'item');
    expect(ca).toEqual(expect.objectContaining({ calleeName: 'next_item', unwrapDepth: 1 }));
  });

  it('does not mark a plain let binding as unwrapped', () => {
    const symbols = parseRust(`fn f() {\n  let service = build_service();\n}`);
    const ca = symbols.callAssignments.find((c) => c.varName === 'service');
    expect(ca?.unwrapDepth).toBe(0);
  });

  it('records a doubly-nested Some pattern with depth two', () => {
    // `Some(Some(x))` — destructuring a doubly-nested `Option<Option<T>>` in a
    // single pattern, the idiomatic way to do it, not two sequential if-lets —
    // must unwrap both layers, not give up after the first (Greptile review,
    // PR #2371).
    const symbols = parseRust(`fn f() {\n  if let Some(Some(user)) = get_nested_option() {}\n}`);
    const ca = symbols.callAssignments.find((c) => c.varName === 'user');
    expect(ca).toEqual(
      expect.objectContaining({ calleeName: 'get_nested_option', unwrapDepth: 2 }),
    );
  });

  it('does not treat a None/unit-variant pattern as a call assignment', () => {
    // `None` is syntactically identical to a bare identifier binding — must not
    // be recorded as if it were a new variable named "None".
    const symbols = parseRust(`fn f() {\n  if let None = build_service() {}\n}`);
    expect(symbols.callAssignments).toHaveLength(0);
  });

  // ── Full generic return types (#2214) ─────────────────────────────────────

  it('preserves the full generic return type (Option<T>, not just Option)', () => {
    const symbols = parseRust(`fn get_user() -> Option<User> { None }`);
    expect(symbols.returnTypeMap.get('get_user')).toEqual(
      expect.objectContaining({ type: 'Option<User>' }),
    );
  });

  it('keeps the bare base name for non-Option/Result generics (Vec<T>, etc.)', () => {
    // Only Option/Result need the type argument preserved (to unwrap a
    // Some(x)/Ok(x) binding) — every other generic keeps its original bare name
    // so CHA/RTA's instantiated-types matching against trait-implementor names is
    // unaffected (Greptile review, PR #2371).
    const symbols = parseRust(`fn get_users() -> Vec<User> { Vec::new() }`);
    expect(symbols.returnTypeMap.get('get_users')).toEqual(
      expect.objectContaining({ type: 'Vec' }),
    );
  });

  it('preserves the full text for a fully-qualified Option (std::option::Option<T>)', () => {
    // `std::option::Option<User>` is just as valid as the bare `Option<User>`
    // spelling and must be recognized the same way (Greptile review, PR #2371).
    const symbols = parseRust(`fn get_user() -> std::option::Option<User> { None }`);
    expect(symbols.returnTypeMap.get('get_user')).toEqual(
      expect.objectContaining({ type: 'std::option::Option<User>' }),
    );
  });

  it('preserves the full text for a reference-wrapped Option (Option<&T>)', () => {
    // `Option<&User>` (a common shape for a cached-field getter) must preserve
    // the type argument, including the reference sigil, the same way any other
    // Option<T> does — unwrapOptionResultType in build-edges.ts strips the `&`
    // at injection time, not extraction time (Greptile review, PR #2371).
    const symbols = parseRust(
      `struct UserService { cached: User }\nimpl UserService {\n  fn get_user_ref(&self) -> Option<&User> { Some(&self.cached) }\n}`,
    );
    expect(symbols.returnTypeMap.get('UserService.get_user_ref')).toEqual(
      expect.objectContaining({ type: 'Option<&User>' }),
    );
  });

  it('preserves a reference to a generic Option (&Option<T>)', () => {
    // `&Option<User>` (a reference TO the Option, not a reference stored
    // inside it) — the old reference_type handling only matched a bare
    // type_identifier/scoped_type_identifier child, never a generic_type
    // child, so this shape returned null entirely and the whole return type
    // was dropped (Greptile review, PR #2371).
    const symbols = parseRust(`fn get_user() -> &Option<User> { &None }`);
    expect(symbols.returnTypeMap.get('get_user')).toEqual(
      expect.objectContaining({ type: 'Option<User>' }),
    );
  });

  // ── Calls embedded in macro invocation arguments (#2214) ──────────────────

  it('scans macro arguments for a method call', () => {
    const symbols = parseRust(`fn f() { println!("{}", user.display_name()); }`);
    expect(symbols.calls).toContainEqual(
      expect.objectContaining({ name: 'display_name', receiver: 'user' }),
    );
    expect(symbols.calls).toContainEqual(expect.objectContaining({ name: 'println!' }));
  });

  it('scans macro arguments for a bare function call', () => {
    const symbols = parseRust(`fn f() { println!("{}", compute_total()); }`);
    const call = symbols.calls.find((c) => c.name === 'compute_total');
    expect(call).toBeDefined();
    expect(call?.receiver).toBeUndefined();
  });

  it('scans nested macro arguments recursively', () => {
    const symbols = parseRust(`fn f() { assert_eq!(compute_total(), other.value()); }`);
    expect(symbols.calls).toContainEqual(expect.objectContaining({ name: 'compute_total' }));
    expect(symbols.calls).toContainEqual(
      expect.objectContaining({ name: 'value', receiver: 'other' }),
    );
  });
});

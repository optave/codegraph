#!/usr/bin/env bash
# Dynamic call tracer for JVM languages (Java, Kotlin, Scala).
# Injects Thread.currentThread().getStackTrace() tracing, compiles, and runs.
#
# Usage: bash jvm-tracer.sh <fixture-dir> [java|kotlin|scala]
# Outputs: { "edges": [...] } JSON to stdout
# Requires: javac/java (Java), kotlinc (Kotlin), scalac (Scala)

set -euo pipefail

FIXTURE_DIR="${1:-}"
LANG="${2:-java}"

if [[ -z "$FIXTURE_DIR" ]]; then
    echo "Usage: jvm-tracer.sh <fixture-dir> [java|kotlin|scala]" >&2
    exit 1
fi

FIXTURE_DIR="$(cd "$FIXTURE_DIR" && pwd)"

# Check for required tools
case "$LANG" in
    java)
        if ! command -v javac &>/dev/null; then
            echo '{"edges":[],"error":"javac not available"}'
            exit 0
        fi
        ;;
    kotlin)
        if ! command -v kotlinc &>/dev/null; then
            echo '{"edges":[],"error":"kotlinc not available"}'
            exit 0
        fi
        ;;
    scala)
        if ! command -v scalac &>/dev/null; then
            echo '{"edges":[],"error":"scalac not available"}'
            exit 0
        fi
        ;;
    groovy)
        if ! command -v groovyc &>/dev/null; then
            echo '{"edges":[],"error":"groovyc not available"}'
            exit 0
        fi
        ;;
esac

TMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TMP_DIR"' EXIT

source "$(dirname "${BASH_SOURCE[0]}")/tracer-common.sh"

# Copy fixture files
case "$LANG" in
    java)   cp "$FIXTURE_DIR"/*.java "$TMP_DIR/" ;;
    kotlin) cp "$FIXTURE_DIR"/*.kt "$TMP_DIR/" ;;
    scala)  cp "$FIXTURE_DIR"/*.scala "$TMP_DIR/" ;;
    groovy) cp "$FIXTURE_DIR"/*.groovy "$TMP_DIR/" ;;
esac

# Create the Tracer utility class
cat > "$TMP_DIR/CallTracer.java" <<'JAVA'
import java.util.*;

public class CallTracer {
    private static final List<Map<String, String>> edges = new ArrayList<>();
    private static final Set<String> seen = new HashSet<>();

    public static void traceCall() {
        StackTraceElement[] stack = Thread.currentThread().getStackTrace();
        // [0] = getStackTrace, [1] = traceCall, [2] = callee, [3] = caller
        if (stack.length < 4) return;

        StackTraceElement callee = stack[2];
        StackTraceElement caller = stack[3];

        String calleeName = cleanName(callee);
        String calleeFile = callee.getFileName();
        String callerName = cleanName(caller);
        String callerFile = caller.getFileName();

        if (calleeFile == null || callerFile == null) return;
        if (calleeFile.equals("CallTracer.java") || callerFile.equals("CallTracer.java")) return;

        String key = callerName + "@" + callerFile + "->" + calleeName + "@" + calleeFile;
        if (!seen.contains(key)) {
            seen.add(key);
            Map<String, String> edge = new LinkedHashMap<>();
            edge.put("source_name", callerName);
            edge.put("source_file", callerFile);
            edge.put("target_name", calleeName);
            edge.put("target_file", calleeFile);
            edges.add(edge);
        }
    }

    private static String cleanName(StackTraceElement el) {
        String cls = el.getClassName();
        String method = el.getMethodName();
        // Strip package prefix
        int dot = cls.lastIndexOf('.');
        if (dot >= 0) cls = cls.substring(dot + 1);
        // Handle inner classes
        cls = cls.replace('$', '.');
        if (method.equals("<init>")) {
            return cls; // Constructor
        }
        if (method.equals("main")) {
            return "main"; // Entry point
        }
        return cls + "." + method;
    }

    public static void dump() {
        StringBuilder sb = new StringBuilder();
        sb.append("{\n  \"edges\": [\n");
        for (int i = 0; i < edges.size(); i++) {
            Map<String, String> e = edges.get(i);
            sb.append("    {\n");
            sb.append("      \"source_name\": \"").append(e.get("source_name")).append("\",\n");
            sb.append("      \"source_file\": \"").append(e.get("source_file")).append("\",\n");
            sb.append("      \"target_name\": \"").append(e.get("target_name")).append("\",\n");
            sb.append("      \"target_file\": \"").append(e.get("target_file")).append("\"\n");
            sb.append("    }");
            if (i < edges.size() - 1) sb.append(",");
            sb.append("\n");
        }
        sb.append("  ]\n}");
        System.out.println(sb.toString());
    }
}
JAVA

# Inject traceCall() into each method
case "$LANG" in
    java)
        for javafile in "$TMP_DIR"/*.java; do
            base="$(basename "$javafile")"
            [[ "$base" == "CallTracer.java" ]] && continue
            # Add CallTracer.traceCall() after method opening braces
            # Match lines like: public void method(...) {
            # The first sed pass matches all method/constructor opening braces,
            # so a second pass is unnecessary (it would double-inject traceCall).
            # The negate pattern also excludes control-flow constructs that share
            # the same "...) {" shape as a method signature (if/else if, while,
            # for, switch, catch, synchronized, try-with-resources) -- see #2045.
            # Unlike kotlin/scala, which anchor on the `fun `/`def ` keyword,
            # java/groovy method signatures have no single leading keyword
            # (`<modifiers> <returnType> <name>(...) {`), so a positive anchor
            # isn't practical here; excluding the known control-flow keywords is
            # the pragmatic option, matching how class/interface are already
            # excluded below.
            #
            # `new[[:space:]]` (#2272) additionally excludes an anonymous class
            # instantiation (`new Runnable() {`), which also shares the "...) {"
            # shape: Java has no default parameter values, so a method's own
            # signature can never itself contain the token `new` followed by
            # whitespace -- any line matching the outer pattern that also
            # contains it is unambiguously an anonymous-class body opening, not
            # a method signature (injecting into it would be invalid Java -- a
            # bare statement directly in a class body -- rather than a distinct
            # method body to trace). Deliberately NOT anchored to an identifier
            # immediately after the whitespace (`new[[:space:]]+[A-Za-z_$]`)
            # -- that missed `new /* comment */ Runnable() {} ` (Greptile
            # review, PR #2449); the bare `new` keyword followed by whitespace
            # is already the unambiguous signal on its own.
            sedi_append_unless '/\)[[:space:]]*\{$/' '/class[[:space:]]|interface[[:space:]]|if[[:space:]]|while[[:space:]]|for[[:space:]]|switch[[:space:]]|catch[[:space:]]|synchronized[[:space:]]|try[[:space:]]|new[[:space:]]/' \
                '        CallTracer.traceCall();' "$javafile"
        done

        # Add dump call at end of main
        sedi_insert_before_end '/public static void main/' '/\}/' '/^[[:space:]]*\}/' \
            '        CallTracer.dump();' "$TMP_DIR/Main.java" 2>/dev/null || true

        # Compile and run
        cd "$TMP_DIR"
        if javac *.java 2>/dev/null; then
            java -cp . Main 2>/dev/null || echo '{"edges":[]}'
        else
            echo '{"edges":[],"error":"javac compilation failed"}'
        fi
        ;;

    kotlin)
        # Strip package declarations so CallTracer (default package) is accessible
        for ktfile in "$TMP_DIR"/*.kt; do
            sedi '/^package /d' "$ktfile"
        done

        # Inject CallTracer.traceCall() into every function body
        for ktfile in "$TMP_DIR"/*.kt; do
            sedi_append_unless '/fun [a-zA-Z].*\{[[:space:]]*$/' '/class |interface |object /' \
                '        CallTracer.traceCall();' "$ktfile"
        done

        # Inject dump call before main's closing brace
        sedi_insert_before_end '/^fun main/' '/^\}/' '/^\}/' \
            '    CallTracer.dump()' "$TMP_DIR/Main.kt"

        # Suppress println to keep stdout clean for JSON
        for ktfile in "$TMP_DIR"/*.kt; do
            sedi 's/println(/System.err.println(/g' "$ktfile" 2>/dev/null || true
        done

        cd "$TMP_DIR"
        if javac CallTracer.java 2>/dev/null && kotlinc -cp . *.kt -include-runtime -d app.jar 2>/dev/null; then
            java -jar app.jar 2>/dev/null || echo '{"edges":[]}'
        else
            echo '{"edges":[],"error":"kotlin compilation failed"}'
        fi
        ;;

    scala)
        # Inject CallTracer.traceCall() into every def body
        for scfile in "$TMP_DIR"/*.scala; do
            base="$(basename "$scfile")"
            sedi_append_unless '/def [a-zA-Z].*\{[[:space:]]*$/' '/class |trait |object .*extends/' \
                '        CallTracer.traceCall();' "$scfile"
        done

        # Inject dump call before main's closing brace
        sedi_insert_before_end '/def main/' '/^[[:space:]]*\}/' '/^[[:space:]]*\}/' \
            '    CallTracer.dump()' "$TMP_DIR/Main.scala"

        # Suppress println to keep stdout clean for JSON
        for scfile in "$TMP_DIR"/*.scala; do
            sedi 's/println(/System.err.println(/g' "$scfile" 2>/dev/null || true
        done

        cd "$TMP_DIR"
        if javac CallTracer.java 2>/dev/null && scalac -cp . *.scala 2>/dev/null; then
            scala -cp . Main 2>/dev/null || echo '{"edges":[]}'
        else
            echo '{"edges":[],"error":"scala compilation failed"}'
        fi
        ;;

    groovy)
        # Strip package declarations so CallTracer (default package) is accessible
        for grfile in "$TMP_DIR"/*.groovy; do
            sedi '/^package /d' "$grfile"
            # Remove cross-package imports that are no longer needed
            sedi '/^import /d' "$grfile"
        done

        # Inject CallTracer.traceCall() into every method body
        # (see the java branch above for why the negate pattern also excludes
        # control-flow keywords -- #2045, and `new[[:space:]]` for anonymous
        # classes -- #2272; Groovy supports Java-style anonymous classes too).
        #
        # `^[[:space:]]*([A-Za-z_][A-Za-zA-Z0-9_]*\.)?[A-Za-z_][A-Za-zA-Z0-9_]*\([^()]*\)[[:space:]]*\{[[:space:]]*$`
        # (#2272) additionally excludes a trailing-closure method CALL, e.g.
        # `list.findAll() {`, a DSL-style `lock.withLock() {`, or the same
        # calls WITHOUT an explicit receiver (`findAll() {`, `withLock() {` --
        # Greptile review, PR #2449, on an earlier version of this fix that
        # only handled the qualified form) -- these share the "...) {" shape
        # but the `traceCall()` would land inside a closure literal, not a
        # real method body. Anchored at the start of the (trimmed) line: a
        # real Groovy method DECLARATION always has a `def`/type/modifier
        # token, separated by WHITESPACE, before the method name -- so the
        # declaration's own name is never the first token on the line -- while
        # a call expression's name (optionally preceded by a `receiver.`) is.
        # A dotted, fully-qualified RETURN TYPE (`java.util.List getUsers() {`)
        # still has a space (not a dot) directly before the method name, so
        # `getUsers` -- not `List` -- would need to start the trimmed line for
        # this to false-positive, which it doesn't.
        for grfile in "$TMP_DIR"/*.groovy; do
            sedi_append_unless '/\)[[:space:]]*\{[[:space:]]*$/' '/class[[:space:]]|interface[[:space:]]|if[[:space:]]|while[[:space:]]|for[[:space:]]|switch[[:space:]]|catch[[:space:]]|synchronized[[:space:]]|try[[:space:]]|new[[:space:]]|^[[:space:]]*([A-Za-z_][A-Za-zA-Z0-9_]*\.)?[A-Za-z_][A-Za-zA-Z0-9_]*\([^()]*\)[[:space:]]*\{[[:space:]]*$/' \
                '        CallTracer.traceCall();' "$grfile"
        done

        # Inject dump call before main's closing brace
        sedi_insert_before_end '/static void main/' '/^[[:space:]]*\}/' '/^[[:space:]]*\}/' \
            '        CallTracer.dump()' "$TMP_DIR/Main.groovy"

        # Suppress println to keep stdout clean for JSON
        for grfile in "$TMP_DIR"/*.groovy; do
            sedi 's/println /System.err.println /g' "$grfile" 2>/dev/null || true
            sedi 's/println("/System.err.println("/g' "$grfile" 2>/dev/null || true
        done

        cd "$TMP_DIR"
        if javac CallTracer.java 2>/dev/null && groovyc -cp . *.groovy 2>/dev/null; then
            groovy -cp . Main 2>/dev/null || echo '{"edges":[]}'
        else
            echo '{"edges":[],"error":"groovy compilation failed"}'
        fi
        ;;
esac

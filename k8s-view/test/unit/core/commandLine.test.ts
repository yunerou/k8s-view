import { describe, expect, test } from "vitest";
import { inputIds, needsShell, splitCommandLine } from "../../../src/core/command/commandLine";

describe("splitCommandLine", () => {
  test("splits on whitespace and honours quotes and escapes", () => {
    expect(splitCommandLine(`kubectl get pods  -l 'app in (a, b)' -o "jsonpath={.items[*].metadata.name}"`)).toEqual([
      "kubectl",
      "get",
      "pods",
      "-l",
      "app in (a, b)",
      "-o",
      "jsonpath={.items[*].metadata.name}",
    ]);
    expect(splitCommandLine(`echo a\\ b "say \\"hi\\"" ''`)).toEqual(["echo", "a b", 'say "hi"', ""]);
  });

  test("keeps templates whole even with spaces inside", () => {
    expect(splitCommandLine("kubectl logs deploy/${input:app} -n ${namespace|default:my ns}")).toEqual([
      "kubectl",
      "logs",
      "deploy/${input:app}",
      "-n",
      "${namespace|default:my ns}",
    ]);
  });

  test("unterminated quote is a syntax error", () => {
    expect(() => splitCommandLine(`echo "oops`)).toThrow(/double quote/);
  });
});

describe("needsShell", () => {
  test("detects pipes, redirects, chaining and substitution outside templates", () => {
    expect(needsShell("kubectl get pods | grep web")).toBe(true);
    expect(needsShell("kubectl get pods > out.txt")).toBe(true);
    expect(needsShell("a && b")).toBe(true);
    expect(needsShell("echo $(date)")).toBe(true);
    expect(needsShell("kubectl get pods -l app=${input:app}")).toBe(false);
    expect(needsShell("kubectl get ${$.spec[?(@.a>1)]}")).toBe(false);
  });
});

describe("inputIds", () => {
  test("unique ids in order, modifiers allowed", () => {
    expect(inputIds("x ${input:app} ${input:tail|default:10} ${input:app} ${namespace}")).toEqual(["app", "tail"]);
  });
});

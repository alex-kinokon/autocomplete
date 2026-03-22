import { describe, expect, it } from "vitest";

import type { DocumentContext } from "../context.ts";
import {
  countBrackets,
  countSuffixExcessClosers,
  postProcessCompletion,
  trimSuffixOverlap,
  trimTrailingWhitespace,
  truncateAtBracketImbalance,
  truncateAtUnclosedString,
} from "../post-process.ts";

const mockContext: DocumentContext = {
  prefix: "function foo() {\n  ",
  suffix: "\n}",
  languageId: "typescript",
  relativePath: "src/index.ts",
  relatedSnippets: [],
};

describe("truncateAtBracketImbalance", () => {
  it("returns text unchanged when brackets are balanced", () => {
    expect(truncateAtBracketImbalance("foo(bar())")).toBe("foo(bar())");
  });

  it("truncates before extra closing paren", () => {
    expect(truncateAtBracketImbalance("foo(bar))")).toBe("foo(bar)");
  });

  it("truncates before extra closing brace", () => {
    expect(truncateAtBracketImbalance("if (x) {\n  return 1;\n}\n}")).toBe(
      "if (x) {\n  return 1;\n}\n"
    );
  });

  it("truncates before extra closing bracket", () => {
    expect(truncateAtBracketImbalance("[1, 2]]")).toBe("[1, 2]");
  });

  it("ignores brackets inside strings", () => {
    expect(truncateAtBracketImbalance('"some ) text"')).toBe('"some ) text"');
    expect(truncateAtBracketImbalance("'some } text'")).toBe("'some } text'");
  });

  it("ignores brackets inside line comments", () => {
    expect(truncateAtBracketImbalance("x // extra )\ny")).toBe("x // extra )\ny");
  });

  it("ignores brackets inside block comments", () => {
    expect(truncateAtBracketImbalance("x /* } */ y")).toBe("x /* } */ y");
  });

  it("handles escaped quotes in strings", () => {
    // The string "a\"b" is properly closed, so the ) after it has no opener
    expect(truncateAtBracketImbalance(String.raw`"a\"b"`)).toBe(String.raw`"a\"b"`);
    // With a balanced paren, everything passes through
    expect(truncateAtBracketImbalance(String.raw`("a\"b")`)).toBe(String.raw`("a\"b")`);
  });

  it("handles template literals", () => {
    expect(truncateAtBracketImbalance("`foo }`")).toBe("`foo }`");
  });

  it("returns empty string for immediate closer", () => {
    expect(truncateAtBracketImbalance("}")).toBe("");
  });
});

describe("truncateAtUnclosedString", () => {
  it("returns text unchanged when no unclosed strings", () => {
    expect(truncateAtUnclosedString('"hello"')).toBe('"hello"');
  });

  it("truncates at last safe newline for unclosed double quote", () => {
    expect(truncateAtUnclosedString('let x = 1;\n"unclosed')).toBe("let x = 1;");
  });

  it("truncates at last safe newline for unclosed single quote", () => {
    expect(truncateAtUnclosedString("let x = 1;\n'unclosed")).toBe("let x = 1;");
  });

  it("allows template literals to span lines", () => {
    const text = "`line1\nline2`";
    expect(truncateAtUnclosedString(text)).toBe(text);
  });

  it("handles escaped quotes inside strings", () => {
    expect(truncateAtUnclosedString(String.raw`"hello\"world"`)).toBe(
      String.raw`"hello\"world"`
    );
  });

  it("rejects single-line unclosed string with no safe newline", () => {
    expect(truncateAtUnclosedString('"unclosed')).toBe("");
  });
});

describe("trimTrailingWhitespace", () => {
  it("trims trailing spaces from each line", () => {
    expect(trimTrailingWhitespace("foo   \nbar  ")).toBe("foo\nbar");
  });

  it("removes trailing blank lines", () => {
    expect(trimTrailingWhitespace("foo\n\n\n")).toBe("foo");
  });

  it("handles empty string", () => {
    expect(trimTrailingWhitespace("")).toBe("");
  });

  it("preserves indentation", () => {
    expect(trimTrailingWhitespace("  foo  \n    bar  ")).toBe("  foo\n    bar");
  });
});

describe("countBrackets", () => {
  it("counts unclosed openers in balanced prefix", () => {
    expect(countBrackets("foo(bar())").toRecord()).toEqual({ "(": 0, "{": 0, "[": 0 });
  });

  it("counts unclosed openers", () => {
    expect(countBrackets("function foo() {\n  ").toRecord()).toEqual({
      "(": 0,
      "{": 1,
      "[": 0,
    });
  });

  it("counts multiple unclosed openers", () => {
    expect(countBrackets("if (x) { arr[").toRecord()).toEqual({ "(": 0, "{": 1, "[": 1 });
  });

  it("clamps negatives to zero (extra closers in prefix)", () => {
    expect(countBrackets("}").toRecord()).toEqual({ "(": 0, "{": 0, "[": 0 });
  });

  it("ignores brackets inside strings and comments", () => {
    expect(countBrackets('"({[" // )]}').toRecord()).toEqual({ "(": 0, "{": 0, "[": 0 });
  });
});

describe("truncateAtBracketImbalance with prefix context", () => {
  it("allows closer that matches opener in prefix", () => {
    const prefixCounts = countBrackets("function foo() {\n  return 1;\n");
    expect(truncateAtBracketImbalance("}\n", prefixCounts)).toBe("}\n");
  });

  it("still truncates at double closer when prefix has one opener", () => {
    const prefixCounts = countBrackets("function foo() {\n");
    expect(truncateAtBracketImbalance("}}", prefixCounts)).toBe("}");
  });

  it("allows nested closers matching prefix", () => {
    const prefixCounts = countBrackets("if (arr[");
    expect(truncateAtBracketImbalance("0])")).toBe("0");
    expect(truncateAtBracketImbalance("0])", prefixCounts)).toBe("0])");
  });
});

describe("postProcessCompletion", () => {
  it("runs the full pipeline", () => {
    // Has an extra closing brace and trailing whitespace
    const input = "return 1;\n}  \n\n";
    const result = postProcessCompletion(input, mockContext);
    // The prefix "function foo() {\n  " has one unclosed brace,
    // but the suffix "\n}" already closes it, so adjusted count is 0.
    // The } in the completion is now excess and gets truncated.
    expect(result).toBe("return 1;");
  });

  it("passes through clean completions", () => {
    const input = "const x = 1;";
    expect(postProcessCompletion(input, mockContext)).toBe("const x = 1;");
  });

  it("allows completion starting with closer when prefix has opener", () => {
    const context: DocumentContext = {
      prefix: "function foo() {\n  return 1;\n",
      suffix: "\n",
      languageId: "typescript",
      relativePath: "src/index.ts",
      relatedSnippets: [],
    };
    expect(postProcessCompletion("}", context)).toBe("}");
  });

  it("strips duplicate ) when suffix already closes the prefix (", () => {
    const context: DocumentContext = {
      prefix: "console.log(",
      suffix: ")",
      languageId: "typescript",
      relativePath: "src/index.ts",
      relatedSnippets: [],
    };
    expect(postProcessCompletion('"hello")', context)).toBe('"hello"');
  });

  it("allows one ) when prefix has 2 unclosed ( and suffix closes 1", () => {
    const context: DocumentContext = {
      prefix: "foo(bar(",
      suffix: ")",
      languageId: "typescript",
      relativePath: "src/index.ts",
      relatedSnippets: [],
    };
    expect(postProcessCompletion('"baz")', context)).toBe('"baz")');
  });

  it("strips duplicate } in multi-line completion when suffix has }", () => {
    const context: DocumentContext = {
      prefix: "if (x) {\n  ",
      suffix: "\n}",
      languageId: "typescript",
      relativePath: "src/index.ts",
      relatedSnippets: [],
    };
    expect(postProcessCompletion("return 1;\n}", context)).toBe("return 1;");
  });

  it("keeps } when suffix is empty", () => {
    const context: DocumentContext = {
      prefix: "if (x) {\n  ",
      suffix: "",
      languageId: "typescript",
      relativePath: "src/index.ts",
      relatedSnippets: [],
    };
    expect(postProcessCompletion("return 1;\n}", context)).toBe("return 1;\n}");
  });

  it("trims same-line suffix overlap for arr[|];", () => {
    const context: DocumentContext = {
      prefix: "arr[",
      suffix: "];",
      languageId: "typescript",
      relativePath: "src/index.ts",
      relatedSnippets: [],
    };
    expect(postProcessCompletion("0];", context)).toBe("0");
  });

  it("skips bracket truncation for prose languages", () => {
    const context: DocumentContext = {
      prefix: "Fix the bug (see ",
      suffix: "",
      languageId: "scminput",
      relativePath: "git/scm0/input",
      relatedSnippets: [],
    };
    expect(postProcessCompletion("issue #42)", context)).toBe("issue #42)");
  });

  it("skips string truncation for prose languages", () => {
    const context: DocumentContext = {
      prefix: "Don",
      suffix: "",
      languageId: "scminput",
      relativePath: "git/scm0/input",
      relatedSnippets: [],
    };
    // eslint-disable-next-line unicorn/string-content -- literal apostrophe in test data
    expect(postProcessCompletion("'t break this", context)).toBe(
      "'t break this" // eslint-disable-line unicorn/string-content
    );
  });

  it("still trims trailing whitespace for prose languages", () => {
    const context: DocumentContext = {
      prefix: "Fix bug",
      suffix: "",
      languageId: "scminput",
      relativePath: "git/scm0/input",
      relatedSnippets: [],
    };
    expect(postProcessCompletion(" in parser  \n\n", context)).toBe(" in parser");
  });
});

describe("countSuffixExcessClosers", () => {
  it("returns zeros for empty suffix", () => {
    expect(countSuffixExcessClosers("").toRecord()).toEqual({ ")": 0, "}": 0, "]": 0 });
  });

  it("counts a single excess closer", () => {
    expect(countSuffixExcessClosers(")").toRecord()).toEqual({ ")": 1, "}": 0, "]": 0 });
  });

  it("counts excess } in suffix with newline", () => {
    expect(countSuffixExcessClosers("\n}").toRecord()).toEqual({
      ")": 0,
      "}": 1,
      "]": 0,
    });
  });

  it("does not count closers matched by openers within suffix", () => {
    expect(countSuffixExcessClosers("(foo)").toRecord()).toEqual({
      ")": 0,
      "}": 0,
      "]": 0,
    });
  });

  it("counts only unmatched closers", () => {
    // ) matches the (, but the second ) is excess
    expect(countSuffixExcessClosers("(foo))").toRecord()).toEqual({
      ")": 1,
      "}": 0,
      "]": 0,
    });
  });

  it("ignores brackets in strings", () => {
    expect(countSuffixExcessClosers('")"').toRecord()).toEqual({
      ")": 0,
      "}": 0,
      "]": 0,
    });
  });

  it("ignores brackets in comments", () => {
    expect(countSuffixExcessClosers("// )\n}").toRecord()).toEqual({
      ")": 0,
      "}": 1,
      "]": 0,
    });
  });

  it("counts multiple bracket types", () => {
    expect(countSuffixExcessClosers("];\n})").toRecord()).toEqual({
      ")": 1,
      "}": 1,
      "]": 1,
    });
  });
});

describe("trimSuffixOverlap", () => {
  it("returns completion unchanged when no overlap", () => {
    expect(trimSuffixOverlap('"hello"', "world")).toBe('"hello"');
  });

  it("does not trim bracket closers (handled by bracket truncation)", () => {
    expect(trimSuffixOverlap('"hello")', ")")).toBe('"hello")');
  });

  it("trims ; overlap but not ] (bracket handled by truncation)", () => {
    // The ] is a bracket closer, not handled here. Only ; is trimmed.
    expect(trimSuffixOverlap("0;", ";")).toBe("0");
  });

  it("does not trim non-closer characters", () => {
    // "exam" overlaps with "ample" but 'a','m' etc are not closers
    expect(trimSuffixOverlap("exam", "ample")).toBe("exam");
  });

  it("handles empty completion", () => {
    expect(trimSuffixOverlap("", ")")).toBe("");
  });

  it("handles empty suffix", () => {
    expect(trimSuffixOverlap('"hello")', "")).toBe('"hello")');
  });

  it("only considers first line of suffix", () => {
    expect(trimSuffixOverlap("x;", ";\n}")).toBe("x");
  });

  it("trims trailing semicolons and whitespace overlap", () => {
    expect(trimSuffixOverlap("x; ", "; ")).toBe("x");
  });
});

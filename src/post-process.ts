/**
 * Completion post-processing pipeline.
 *
 * Validates and truncates raw completions to avoid inserting unbalanced
 * brackets, unterminated strings, or trailing whitespace.
 */
import type { DocumentContext } from "./context.ts";

/**
 * Run the full post-processing pipeline on a completion.
 *
 * 1. Truncate at bracket imbalance (extra closer already in suffix)
 * 2. Truncate at unclosed string literal
 * 3. Trim trailing whitespace per-line and remove trailing blank lines
 *
 * @param text Raw completion text from the model
 * @param context Document context (prefix is used to seed bracket counts)
 */
export function postProcessCompletion(text: string, context: DocumentContext): string {
  let result = text;
  result = truncateAtBracketImbalance(result, countBrackets(context.prefix));
  result = truncateAtUnclosedString(result);
  result = trimTrailingWhitespace(result);
  return result;
}

/**
 * Scan characters tracking `(){}[]` counts (skipping string and comment
 * interiors). When a closer makes its bracket type go negative, truncate
 * before it. The extra closer is likely already present in the suffix.
 *
 * Handles `//` line comments, `/* * /` block comments, and `"` `'` `` ` ``
 * string delimiters (with backslash escape awareness).
 *
 * @param text Completion text to scan
 * @param initialCounts Bracket counts seeded from the prefix so that closers
 *   matching openers in the prefix are not treated as imbalanced.
 */
export function truncateAtBracketImbalance(
  text: string,
  initialCounts: Record<string, number> = { "(": 0, "{": 0, "[": 0 }
): string {
  const counts: Record<string, number> = { ...initialCounts };
  const closerToOpener: Record<string, string> = {
    ")": "(",
    "}": "{",
    "]": "[",
  };

  let inString: string | false = false;
  let inLineComment = false;
  let inBlockComment = false;
  let escaped = false;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    const next = text[i + 1];

    // Handle escape sequences inside strings
    if (escaped) {
      escaped = false;
      continue;
    }

    // Inside a string literal
    if (inString) {
      if (ch === "\\") {
        escaped = true;
      } else if (ch === inString) {
        inString = false;
      }
      continue;
    }

    // Inside a line comment
    if (inLineComment) {
      if (ch === "\n") {
        inLineComment = false;
      }
      continue;
    }

    // Inside a block comment
    if (inBlockComment) {
      if (ch === "*" && next === "/") {
        inBlockComment = false;
        i++; // skip the /
      }
      continue;
    }

    // Detect comment starts
    if (ch === "/" && next === "/") {
      inLineComment = true;
      i++;
      continue;
    }
    if (ch === "/" && next === "*") {
      inBlockComment = true;
      i++;
      continue;
    }

    // Detect string starts
    if (ch === '"' || ch === "'" || ch === "`") {
      inString = ch;
      continue;
    }

    // Track brackets
    if (ch === "(" || ch === "{" || ch === "[") {
      counts[ch]!++;
    } else if (ch in closerToOpener) {
      const opener = closerToOpener[ch]!;
      counts[opener]!--;
      if (counts[opener]! < 0) {
        return text.slice(0, i);
      }
    }
  }

  return text;
}

/**
 * Count bracket balance in text, skipping strings and comments.
 * Returns counts keyed by opener: `{ "(": n, "{": n, "[": n }`.
 */
export function countBrackets(text: string): Record<string, number> {
  const counts: Record<string, number> = { "(": 0, "{": 0, "[": 0 };
  const closerToOpener: Record<string, string> = {
    ")": "(",
    "}": "{",
    "]": "[",
  };

  let inString: string | false = false;
  let inLineComment = false;
  let inBlockComment = false;
  let escaped = false;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    const next = text[i + 1];

    if (escaped) {
      escaped = false;
      continue;
    }

    if (inString) {
      if (ch === "\\") {
        escaped = true;
      } else if (ch === inString) {
        inString = false;
      }
      continue;
    }
    if (inLineComment) {
      if (ch === "\n") {
        inLineComment = false;
      }
      continue;
    }
    if (inBlockComment) {
      if (ch === "*" && next === "/") {
        inBlockComment = false;
        i++;
      }
      continue;
    }
    if (ch === "/" && next === "/") {
      inLineComment = true;
      i++;
      continue;
    }
    if (ch === "/" && next === "*") {
      inBlockComment = true;
      i++;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") {
      inString = ch;
      continue;
    }

    if (ch === "(" || ch === "{" || ch === "[") {
      counts[ch]!++;
    } else if (ch in closerToOpener) {
      counts[closerToOpener[ch]!]!--;
    }
  }

  // Clamp negatives to 0. We only care about unclosed openers
  for (const [key, value] of Object.entries(counts)) {
    if (value < 0) counts[key] = 0;
  }

  return counts;
}

/**
 * If the text ends inside an unclosed quote, truncate to the last newline
 * outside a string.
 */
export function truncateAtUnclosedString(text: string): string {
  let inString: string | false = false;
  let escaped = false;
  let lastSafeNewline = -1;

  // eslint-disable-next-line unicorn/no-for-loop -- need code-unit index for string slicing
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;

    if (escaped) {
      escaped = false;
      continue;
    }

    if (inString) {
      if (ch === "\\") {
        escaped = true;
      } else if (ch === inString) {
        inString = false;
      } else if (ch === "\n" && inString !== "`") {
        // Single/double-quoted strings can’t span lines (except template literals)
        inString = false;
        lastSafeNewline = i;
      }
      continue;
    }

    if (ch === "\n") {
      lastSafeNewline = i;
    } else if (ch === '"' || ch === "'" || ch === "`") {
      inString = ch;
    }
  }

  // If we ended inside a string, truncate to last safe newline.
  // If no safe newline exists (single-line unclosed string), reject entirely.
  if (inString) {
    return lastSafeNewline >= 0 ? text.slice(0, lastSafeNewline) : "";
  }

  return text;
}

/**
 * Trim trailing whitespace from each line and remove trailing blank lines.
 */
export function trimTrailingWhitespace(text: string): string {
  if (!text) return text;
  const lines = text.split("\n");
  const trimmed = lines.map(line => line.trimEnd());

  // Remove trailing blank lines
  while (trimmed.length > 0 && trimmed.at(-1) === "") {
    trimmed.pop();
  }

  return trimmed.join("\n");
}

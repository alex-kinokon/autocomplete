/**
 * Completion post-processing pipeline.
 *
 * Validates and truncates raw completions to avoid inserting unbalanced
 * brackets, unterminated strings, or trailing whitespace.
 */
import type { DocumentContext } from "./context.ts";
import { isProseLanguage } from "./context.ts";
import { type CounterMap, createCounterMap } from "./counter-map.ts";

/** Bracket opener characters. */
const OPENERS: readonly string[] = ["(", "{", "["];

/** Bracket closer characters. */
const CLOSERS: readonly string[] = [")", "}", "]"];

/** Map from closing bracket to its corresponding opener. */
const CLOSER_TO_OPENER = new Map([
  [")", "("],
  ["}", "{"],
  ["]", "["],
]);

/**
 * Iterate over code-level characters in `text`, skipping string literals
 * (`"`, `'`, `` ` ``), line comments (`//`), and block comments.
 *
 * Calls `onCode(ch, i)` for each character that is outside strings and
 * comments. Return `false` from the callback to stop scanning early.
 */
function scanCode(
  text: string,
  onCode: (ch: string, i: number) => false | undefined
): void {
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

    if (onCode(ch, i) === false) return;
  }
}

/**
 * Run the full post-processing pipeline on a completion.
 *
 * 1. Truncate at bracket imbalance (suffix-adjusted counts)
 * 2. Truncate at unclosed string literal
 * 3. Trim trailing whitespace per-line and remove trailing blank lines
 * 4. Trim suffix overlap (completion tail duplicating suffix head)
 *
 * @param text Raw completion text from the model
 * @param context Document context (prefix/suffix used to seed bracket counts)
 */
export function postProcessCompletion(text: string, context: DocumentContext): string {
  let result = stripPrefixEcho(text, context.prefix);

  if (!isProseLanguage(context.languageId)) {
    const prefixCounts = countBrackets(context.prefix);
    const suffixExcess = countSuffixExcessClosers(context.suffix);
    const adjusted = createCounterMap(OPENERS);
    for (const [closer, opener] of CLOSER_TO_OPENER) {
      adjusted.set(
        opener,
        Math.max(0, prefixCounts.get(opener) - suffixExcess.get(closer))
      );
    }

    result = truncateAtBracketImbalance(result, adjusted);
    result = truncateAtUnclosedString(result);
  }

  result = trimTrailingWhitespace(result);
  result = trimSuffixOverlap(result, context.suffix);
  return result;
}

/**
 * Scan characters tracking `(){}[]` counts (skipping string and comment
 * interiors). When a closer makes its bracket type go negative, truncate
 * before it. The extra closer is likely already present in the suffix.
 *
 * @param text Completion text to scan
 * @param initialCounts Bracket counts seeded from the prefix so that closers
 *   matching openers in the prefix are not treated as imbalanced.
 */
export function truncateAtBracketImbalance(
  text: string,
  initialCounts = createCounterMap(OPENERS)
): string {
  const counts = initialCounts.copy();
  let truncateAt = -1;

  scanCode(text, (ch, i): false | undefined => {
    if (ch === "(" || ch === "{" || ch === "[") {
      counts.inc(ch);
    } else {
      const opener = CLOSER_TO_OPENER.get(ch);
      if (opener !== undefined && counts.dec(opener) < 0) {
        truncateAt = i;
        return false;
      }
    }
    return;
  });

  return truncateAt >= 0 ? text.slice(0, truncateAt) : text;
}

/**
 * Count bracket balance in text, skipping strings and comments.
 * Returns counts keyed by opener: `("(" → n, "{" → n, "[" → n)`.
 */
export function countBrackets(text: string): CounterMap {
  const counts = createCounterMap(OPENERS);

  scanCode(text, (ch): undefined => {
    if (ch === "(" || ch === "{" || ch === "[") {
      counts.inc(ch);
    } else {
      const opener = CLOSER_TO_OPENER.get(ch);
      if (opener !== undefined) {
        counts.dec(opener);
      }
    }
  });

  counts.clampNegatives();
  return counts;
}

/**
 * If the text ends inside an unclosed quote, truncate to the last newline
 * outside a string.
 *
 * Note: this uses its own scanner (not `scanCode`) because it needs to track
 * newlines inside non-template strings and does not skip comments.
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

/**
 * Count excess closing brackets in the suffix. Closers that don’t match any
 * opener *within* the suffix itself. These close openers from the prefix.
 *
 * Returns counts keyed by closer character: `(")" → n, "}" → n, "]" → n)`.
 */
export function countSuffixExcessClosers(suffix: string): CounterMap {
  const openers = createCounterMap(OPENERS);
  const excess = createCounterMap(CLOSERS);

  scanCode(suffix, (ch): undefined => {
    if (ch === "(" || ch === "{" || ch === "[") {
      openers.inc(ch);
    } else {
      const opener = CLOSER_TO_OPENER.get(ch);
      if (opener !== undefined) {
        if (openers.get(opener) > 0) {
          openers.dec(opener);
        } else {
          excess.inc(ch);
        }
      }
    }
  });

  return excess;
}

// Bracket closers are already handled by suffix-adjusted
// truncateAtBracketImbalance, so we only trim non-bracket closers here.
const SUFFIX_OVERLAP_CHARS = new Set(['"', "'", ";", ",", " ", "\t"]);

/**
 * Trim the longest tail of the completion that matches the head of the
 * suffix’s first line. Only trims non-bracket closer characters (`"';,`
 * and whitespace) to avoid false positives. Bracket closers are already
 * handled by suffix-adjusted truncateAtBracketImbalance.
 */
export function trimSuffixOverlap(completion: string, suffix: string): string {
  if (!completion || !suffix) return completion;

  // Only consider the first line of the suffix (cursor to end-of-line)
  const newlineIdx = suffix.indexOf("\n");
  const suffixFirstLine = newlineIdx !== -1 ? suffix.slice(0, newlineIdx) : suffix;
  if (!suffixFirstLine) return completion;

  // Find the longest tail of completion matching head of suffixFirstLine,
  // restricted to closer characters only.
  let bestLen = 0;
  for (let len = 1; len <= Math.min(completion.length, suffixFirstLine.length); len++) {
    const tail = completion.slice(completion.length - len);

    // Every character in the overlap must be a closer character
    let allClosers = true;
    for (const ch of tail) {
      if (!SUFFIX_OVERLAP_CHARS.has(ch)) {
        allClosers = false;
        break;
      }
    }
    if (!allClosers) break;

    if (tail === suffixFirstLine.slice(0, len)) {
      bestLen = len;
    }
  }

  if (bestLen > 0) {
    return completion.slice(0, completion.length - bestLen);
  }
  return completion;
}

/**
 * Strip prefix echo from the completion. Chat models sometimes repeat part
 * or all of the prefix before producing the actual completion. Find the
 * longest head of `completion` that matches a tail of `prefix` and strip it.
 *
 * Requires at least 10 characters of overlap to avoid false positives.
 */
export function stripPrefixEcho(completion: string, prefix: string): string {
  const maxOverlap = Math.min(completion.length, prefix.length);
  for (let len = maxOverlap; len >= 10; len--) {
    if (prefix.endsWith(completion.slice(0, len))) {
      return completion.slice(len);
    }
  }
  return completion;
}

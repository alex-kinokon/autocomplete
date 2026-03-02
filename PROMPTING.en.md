# A Note on Prompting

[Français](PROMPTING.fr.md)

This is an attempt to summarize practical prompting patterns for inline code completion, grounded in open-source implementations (Continue.dev, Sourcegraph Cody, Tabby, GitHub Copilot), model documentation (DeepSeek, Qwen, CodeLlama, StarCoder, Codestral), and recent Fill-in-the-Middle research. Think of it as lessons learned, minus the part where you lose a weekend to one invisible token.

---

## Fill-in-the-Middle (FIM)

Traditional autocompletion is left-to-right. The model sees everything before the cursor and guesses what comes next. FIM flips this on its head by giving the model the code _before_ and _after_ the cursor, and asking it to fill in the gap. It’s a simple idea, but the difference in practice is huge. The model doesn’t just know where the code is coming from, it knows where it needs to land. Think of it as the difference between finishing someone’s sentence when you can only hear what they’ve said so far, versus filling in the blank when you can read the whole sentence. Same words, very different odds of getting it right.

### Two Ways to Order the Prompt: PSM and SPM

Here’s the fundamental tension. You have three pieces (prefix, suffix, middle) but the model still generates tokens left-to-right. How do you arrange them? There are two standard answers, which of course the community couldn’t resist naming with three-letter acronyms.

The intuitive answer is PSM (Prefix-Suffix-Middle): prefix first, then suffix, then the model fills the middle:

```
[PREFIX_TOKEN] prefix [SUFFIX_TOKEN] suffix [MIDDLE_TOKEN] → model generates here
```

This is what most inference servers (including Ollama) implement, and what you’ll encounter in most model APIs.

The clever answer is SPM (Suffix-Prefix-Middle): suffix first, _then_ prefix, then the model continues:

```
[SUFFIX_TOKEN] suffix [PREFIX_TOKEN] prefix [MIDDLE_TOKEN] → model generates here
```

Why would you put the suffix first? Because now the prefix and the generated middle form one contiguous sequence. There’s no awkward jump; the model just keeps writing from the prefix, which is exactly what autoregressive models are good at. As a bonus, SPM plays nicer with KV caching,[^19] since appending tokens to the prefix doesn’t blow away the cached suffix computation.

And it works. [The original FIM paper](https://arxiv.org/abs/2207.14255) found SPM outperforming PSM across all three benchmark types (single-line, multi-line, and random span infilling) and across model scales. [CodeLlama’s evaluations](https://arxiv.org/abs/2308.12950) saw SPM win by 2–6 points on single-line infilling (Table 6), though PSM pulled ahead on random span infilling when token healing wasn’t implemented (Section 3.2). The general trend favors SPM for the kinds of completions autocomplete cares about most.

That said, most models are trained on both. [CodeLlama](https://arxiv.org/abs/2308.12950) applies FIM to 90% of its training data and splits that evenly between PSM and SPM (Section 2.3), getting strong performance on both orderings. The [foundational FIM paper](https://arxiv.org/abs/2207.14255) found that applying FIM transformation to around 50–90% of training data gives you strong infilling without hurting ordinary left-to-right generation, so there’s no real tradeoff. Diplomacy wins.

### Model-Specific Token Formats

Every model family has its own sentinel tokens. The differences look minor, and that’s exactly what makes them dangerous. Getting them wrong means the model treats the tokens as literal text rather than structural markers, and it will not complain.[^18] Here’s the cheat sheet:

| Model                          | Prefix Token        | Suffix Token        | Middle Token        | Notes                                                                   |
| ------------------------------ | ------------------- | ------------------- | ------------------- | ----------------------------------------------------------------------- |
| **Qwen2.5-Coder**[^13]         | `<\|fim_prefix\|>`  | `<\|fim_suffix\|>`  | `<\|fim_middle\|>`  | Also supports multi-file with `<\|repo_name\|>` and `<\|file_sep\|>`    |
| **StarCoder / StarCoder2**[^6] | `<fim_prefix>`      | `<fim_suffix>`      | `<fim_middle>`      | Note: no pipe characters. StarCoder2-3b/7b recommended over 15b for FIM |
| **CodeLlama**[^7]              | `<PRE>` (id 32007)  | `<SUF>` (id 32008)  | `<MID>` (id 32009)  | Also has `<EOT>` (id 32010). Supports `suffix_first` flag for SPM       |
| **DeepSeek Coder**[^8]         | `<｜fim▁begin｜>`   | `<｜fim▁hole｜>`    | `<｜fim▁end｜>`     | Full-width characters. API requires `base_url=.../beta`. Max 4K tokens  |
| **Codestral (Mistral)**[^9]    | Server-managed      | Server-managed      | Server-managed      | Uses `prompt` + `suffix` API fields. Dedicated `/fim` endpoint          |
| **Stable Code**[^10]           | `<fim_prefix>`      | `<fim_suffix>`      | `<fim_middle>`      | Same as StarCoder format                                                |
| **CodeGeeX**[^11]              | `<\|code_prefix\|>` | `<\|code_suffix\|>` | `<\|code_middle\|>` | Uses SPM ordering. Wrapped with `<\|user\|>` / `<\|assistant\|>` tokens |

A few traps await the unwary. StarCoder uses `<fim_prefix>` without pipes, while Qwen uses `<|fim_prefix|>` with them. Easy to mix up, and the model won’t tell you it’s confused. DeepSeek is the sneakiest. Those are full-width Unicode characters[^17] (`｜` U+FF5C and `▁` U+2581), not their ASCII lookalikes. Please don’t ask me how long it took for me to figure this out.

### Template Examples from Continue.dev

Continue.dev maintains FIM templates for every major model in [`AutocompleteTemplate.ts`](https://github.com/continuedev/continue/blob/533fb83c3cd62252a263937950d3d441f3871ba9/core/autocomplete/templating/AutocompleteTemplate.ts), saving you from the character-by-character token archaeology described above. Here are the actual prompt strings (using `${variable}` interpolation):

**[StarCoder2](https://github.com/continuedev/continue/blob/533fb83c3cd62252a263937950d3d441f3871ba9/core/autocomplete/templating/AutocompleteTemplate.ts#L244):**

```
${otherFiles}<fim_prefix>${prefix}<fim_suffix>${suffix}<fim_middle>
```

**[CodeLlama](https://github.com/continuedev/continue/blob/533fb83c3cd62252a263937950d3d441f3871ba9/core/autocomplete/templating/AutocompleteTemplate.ts#L277):**

```
<PRE> ${prefix} <SUF>${suffix} <MID>
```

**[DeepSeek](https://github.com/continuedev/continue/blob/533fb83c3cd62252a263937950d3d441f3871ba9/core/autocomplete/templating/AutocompleteTemplate.ts#L283):**

```
<｜fim▁begin｜>${prefix}<｜fim▁hole｜>${suffix}<｜fim▁end｜>
```

**[Qwen (multi-file)](https://github.com/continuedev/continue/blob/533fb83c3cd62252a263937950d3d441f3871ba9/core/autocomplete/templating/AutocompleteTemplate.ts#L56):**

```
<|repo_name|>${reponame}
${fileContents}
<|file_sep|>${currentFilePath}
<|fim_prefix|>${prefix}<|fim_suffix|>${suffix}<|fim_middle|>
```

**Codestral (multi-file):** Continue’s [Codestral template](https://github.com/continuedev/continue/blob/533fb83c3cd62252a263937950d3d441f3871ba9/core/autocomplete/templating/AutocompleteTemplate.ts) weaves referenced file context into the prompt, prepending `[SUFFIX]` and `[PREFIX]` tokens with full file paths.

### Server-Managed vs Manual Token Embedding

There are two ways to get FIM tokens into a prompt, and the choice mostly comes down to how much you enjoy avoidable suffering.

The easy path is server-managed FIM. Ollama supports it natively. You send `prompt` and `suffix` as separate JSON fields in the `/api/generate` request, and the server wraps them with the correct FIM template for whatever model is loaded. You don’t need to know which tokens the model expects; the server handles it. It’s like using an ORM: less control, fewer 2 a.m. mysteries. One caveat: Ollama decides whether a model supports FIM by checking if its Modelfile template contains `{{.Suffix}}`. Some base models that are FIM-trained (e.g. qwen2.5-coder base) get [incorrectly rejected](https://github.com/ollama/ollama/issues/7052) because their bundled template omits it, while the instruct variant of the same model works fine.

Fair warning, though. Ollama’s Go template engine [treats the empty string as falsy](https://github.com/ollama/ollama/issues/6932) for the suffix field. If you send `"suffix": ""`, Ollama quietly skips FIM templating and falls back to plain chat mode. You’ll get completions, they’ll just be worse, and you’ll spend an hour wondering why. The fix is dead simple. Send a non-empty string like `" "` instead of `""`.

The alternative is manual token embedding, where you build the full prompt yourself, something like `PREFIX_TOKEN + preamble + prefix + SUFFIX_TOKEN + suffix + MIDDLE_TOKEN`. More work, but necessary when the server doesn’t support FIM natively. The downside is maintaining per-model template logic in your client code, which is roughly as fun as it sounds.

---

## Context Gathering

This is obvious, but the quality of a completion depends at least as much on _what context you send_ as on which model you use. You can agonize over model selection all day, but feeding the wrong context to the right model will still produce junk with great confidence. All the major autocomplete extensions pour serious effort into context selection, and they’ve converged on a common toolkit.

### The Signals Everyone Uses

The most obvious signal is the prefix and suffix from the current file. Every extension includes the code before and after the cursor, with the prefix getting top billing. The question is just proportions, and Continue [defaults](https://github.com/continuedev/continue/blob/de12be19ce81f0ee17f950c1ee5b6b00f70ec5bf/core/util/parameters.ts) to 30% of the token budget for prefix and 20% for suffix.

The cheapest win in the whole stack, though, is the file path and language identifier. Prepending `// Path: src/utils/parser.ts` as a comment costs a handful of tokens and gives the model a strong hint about the module’s purpose. [Research on context composing](https://arxiv.org/abs/2402.09230) confirmed that structuring this as `file_extension + language_separator + file_path + metadata_separator + code` measurably improves quality. A few tokens of metadata, doing more work than entire paragraphs of code context. Go figure.

The next ring of context comes from open editor tabs. Copilot[^12] and Cody both look at files the developer currently has open, and Continue considers recently opened or edited files automatically. If you have a file open, you’re probably working with it. (Or you opened it three days ago and forgot about it, but on average this heuristic works.) Continue takes this further with its [`RecentlyEditedTracker`](https://github.com/continuedev/continue/blob/de12be19ce81f0ee17f950c1ee5b6b00f70ec5bf/extensions/vscode/src/autocomplete/recentlyEdited.ts), which is designed to keep up to 3 recent edit ranges per file with a 2-minute staleness window. So if you just changed `formatDate`, completions in a file that calls it will pick up on those changes.

There are always too many imports to include wholesale, so Continue uses [import-matched symbols](https://docs.continue.dev/ide-extensions/autocomplete/context-selection). It looks at the symbols near the cursor, figures out which ones correspond to imports, and pulls in those definitions. Smart and cheap — our two favorite adjectives for engineering decisions (and coffee).

One of the more powerful signals is LSP go-to-definition. Continue uses the Language Server Protocol exactly like a developer uses ⌘-click. Typing a function call? It pulls in the function definition. Inside a method body? It grabs the type definitions for the parameters and return type. This is the kind of context that turns a mediocre completion into a great one.

Continue’s signature move is [root path context](https://web.archive.org/web/20251118163602/https://blog.continue.dev/root-path-context-the-secret-ingredient-in-continues-autocomplete-prompt/). Instead of indexing the whole repo, it traces the path from a syntax tree node up to the root. This lets it “seemingly understand your entire codebase while only actually reading a fraction.” It’s also naturally cacheable, since the same root path gives the same context no matter where the cursor sits within a subtree. Both Cody and Tabby use tree-sitter for a related but different purpose. Cody [uses it to classify _intent_](https://sourcegraph.com/blog/the-lifecycle-of-a-code-ai-completion), asking whether the developer is filling in a function body, writing a docstring, or implementing a method call. Different intents get different context strategies. Tabby uses it more for parsing code into structured tags.

Then there’s the heavy artillery, repository-level RAG. [Tabby](https://deepwiki.com/TabbyML/tabby/3.2-code-completion-service) runs dual retrieval, combining semantic search via embeddings with keyword-based BM25, merged with Reciprocal Rank Fusion. Effective, but it requires indexing infrastructure that not everyone wants to set up. Sometimes you just want autocomplete, not an accidental PhD in retrieval systems.

### How Extensions Prioritize Context

With a limited token budget, something has to give. Here’s how the major tools decide what stays and what gets cut.

[Tabby](https://deepwiki.com/TabbyML/tabby/3.2-code-completion-service) sets a max prompt length per model and fills it in priority order, with prefix/suffix first and the best retrieved snippets after. When space runs out, the least relevant snippets get dropped. Last in, first out, just like your startup’s hiring plan. Cody takes a different approach, [optimizing for speed over breadth](https://sourcegraph.com/blog/the-lifecycle-of-a-code-ai-completion). For autocomplete (as opposed to chat), it prioritizes local context, with tree-sitter evaluating intent continuously while you type. Copilot pre-processes surrounding code, mixes in information from open tabs, and packs it into a single prompt.[^12]

Continue is the most transparent about its budgeting. The [defaults](https://github.com/continuedev/continue/blob/de12be19ce81f0ee17f950c1ee5b6b00f70ec5bf/core/util/parameters.ts) are telling:

- `maxPromptTokens`: 1024
- `prefixPercentage`: 0.3 (30% for prefix)
- `maxSuffixPercentage`: 0.2 (20% for suffix)
- The remaining ~50% goes to context from other files, definitions, and snippets

That 30/20/50 split is the result of a lot of experimentation. It’s a good starting point if you’re building your own.

### More Context Isn’t Always Better

This is counterintuitive but important. Sourcegraph’s internal experiments found that [“adding irrelevant context can make response quality worse.”](https://sourcegraph.com/blog/the-lifecycle-of-a-code-ai-completion) Throwing everything into the prompt is the context-gathering equivalent of packing your entire wardrobe for a weekend trip. Technically possible, not actually helpful.

That said, _relevant_ context matters a lot. [One paper](https://arxiv.org/abs/2402.09230) found that bumping the max context from 384 to 1536 tokens (by switching from a GPT-family model to LLaMA) improved completion quality by 40%, with basically no latency cost. Separately, [research on curriculum-based FIM fine-tuning](https://arxiv.org/abs/2412.16589) found that smaller models benefit more from improved training. A 1B model gained 6.25% while a 7B model gained only 1.25%. The pattern generalizes. A small model is more easily confused by ambiguity, and better context or training resolves ambiguity. Think of it as giving directions to a tourist versus a local. The tourist needs a lot more detail.

---

## Chat-Based Completion (the Non-FIM Fallback)

Not every model speaks FIM. When you’re stuck with a general-purpose chat model (GPT-4, Claude, Llama-chat, etc.), you have to frame the completion as a conversation. It works (sort of) but it takes some wrangling. It’s a bit like asking a keynote speaker to just quietly finish your sentence. They _can_ do it, but their instincts will fight you every step of the way.

### The System Prompt

The system prompt has two jobs: tell the model it’s a code completion engine, and forbid everything else as aggressively as possible. Here’s what we’ve landed on:

```txt
You are a code completion engine. Continue the code from where the prefix ends.
Output ONLY the raw code to insert. NEVER output explanations, comments about
the code, conversational text, or markdown. Do not repeat existing code. Match
the indentation and style. If unsure, output nothing.
```

Every piece of this prompt is load-bearing. Remove one and the model immediately remembers it was trained to be chatty.

Calling it a “code completion engine” rather than a “helpful assistant” sets the tone for the rest of the prompt. These models have been RLHFed to within an inch of their lives to be helpful and friendly, so you need to be very firm. You also need to explicitly forbid everything you don’t want. Markdown, explanations, conversational filler. If you don’t ban it, the model will helpfully provide it. “Here’s the code you asked for!” it chirps, wrapping your one-line completion in a three-paragraph essay.

Telling it to match the indentation and style matters more than you’d think. Without this, models impose their own formatting preferences, which is jarring in the middle of someone else’s code. And “if unsure, output nothing” prevents hallucinated completions. Better to show nothing than to show wrong code.

Most autocomplete implementations keep temperature low (Continue defaults to near-zero). Creativity is great for poetry; for autocomplete, you want boring, correct, and done before your train of thought evaporates.

### Structuring the User Message

Present the code with clear delimiters so the model knows exactly where to insert:

```xml
<file path="src/index.ts" language="typescript">
<related_context>
--- utils.ts ---
export function helper() { ... }
</related_context>
<prefix>import { helper } from './utils';

function main() {
  const result = </prefix>
<suffix>
  console.log(result);
}</suffix>
</file>
```

### What Goes Wrong

You’ll hit these issues. Everyone does.

The big one is markdown wrapping. Chat models are trained to put code in fenced blocks (` ```lang ... ``` `), and they’ll do it even when you explicitly say not to. The system prompt is more of a suggestion to them, apparently. You need post-processing to strip the opening fence and truncate at the closing one. Explanatory preambles like “Here’s the completion:” show up constantly too. Some models can’t resist being helpful. It’s like telling a golden retriever not to fetch. Models also love to echo the prefix, repeating the last few lines of code you gave them before producing the actual completion, so explicitly say “Do not repeat existing code” in the system prompt.

The real issue, though, is more fundamental. General-purpose chat models just aren’t built for this. Continue’s documentation is refreshingly honest about it: [“Chat models, though larger, will often perform poorly even with extensive prompting.”](https://github.com/continuedev/continue/blob/32d7ba280f4cbb0052d9d07786865c8ebebea8f1/docs/customize/model-roles/autocomplete.mdx) In practice, a small FIM-trained model will usually outperform a much larger chat model at autocomplete. The chat path is a compatibility fallback, not the happy path, and definitely not the fast path.

---

## Advanced FIM Techniques

These come from recent research and mostly require changes to model training. But understanding them shapes how you think about prompt construction and post-processing, even if you’re not training your own model. (And if you are training your own model, please consider a career in therapy instead — at least your clients can tell you what’s wrong.)

### Horizon-Length Prediction (HLP)

Standard FIM training uses next-token prediction, where the model learns to predict each token from the ones before it.[^1] The problem is, this doesn’t teach models to _plan ahead_. When the middle section is long, the model starts writing without knowing how much room it has before the suffix. It’s the equivalent of starting a story without knowing you only have two paragraphs before “The End.”

[HLP](https://arxiv.org/abs/2410.03103) adds a clever second objective. At each step, the model also predicts the fraction of the middle section still remaining — a normalized value `(M-t)/M` that shrinks from 1 toward 0 as the model writes.[^1] It’s like giving the model a progress bar rather than having it write blind. The payoff is impressive. Up to 24% relative improvement[^1] on repository-level FIM benchmarks, with gains on file-level tasks too. Code reasoning improves as a side effect (up to 6% on CRUXEval).[^1] And it’s basically free. The added prediction head is less than 0.01% of model parameters and is discarded at inference, so there’s zero inference cost.[^1] This is one of those rare “strictly better” improvements. We don’t get many of those, so enjoy it.

### AST-Aware FIM (AST-FIM)

Standard FIM training masks random character spans,[^2] which often chop code in awkward places. The middle of an expression, halfway through a variable name, that sort of thing. It’s like learning to do jigsaw puzzles where someone cut the pieces with scissors instead of a die cutter. [AST-FIM](https://arxiv.org/abs/2506.00204) is smarter about this. It masks complete subtrees from the Abstract Syntax Tree.[^2] A whole function definition. A complete expression. An entire if statement.

This matches how developers actually write code — "real-world code edits often involve complete syntactic units."[^2] You don’t insert random characters; you write a function body, add an argument, fill in a method call. Training on these natural units helps. AST-FIM beats random-character FIM by up to 5 points on SAFIM benchmarks.[^2]

### Syntax-Aware Post-Processing

Here’s a nice one. You can improve completions _without changing the model at all_ by truncating them at syntactically valid boundaries. AST-based truncation cuts down compilation errors with no GPU cost. Free improvements, our favorite kind.

Sourcegraph’s Cody [does this in production](https://sourcegraph.com/blog/the-lifecycle-of-a-code-ai-completion) with tree-sitter:

- If a completion’s first line starts a new block (function body, if-branch), Cody lets the model keep going instead of cutting at one line.
- Multi-line completions get truncated at syntactically complete boundaries.
- When a completion shares a line with the suffix, bracket matching prevents duplicated closing brackets.

This is probably the lowest-hanging fruit for improving an existing autocomplete system. If you implement one thing from this section, make it this.

### Instruction-Aware FIM (IFIM)

[IFIM](https://arxiv.org/abs/2509.24637) adds a natural language instruction to the FIM prompt describing what the developer intends. When the code context is ambiguous, consistent with multiple valid completions, the instruction breaks the tie. It boosts intent accuracy by 9 percentage points without hurting baseline FIM performance.

The catch is that you need a way to infer or elicit the developer’s intent, which isn’t always straightforward. Developers are not known for articulating what they want before they write it. (See also: every Jira ticket ever.)

### Multi-File FIM Context

Basic FIM prompts only include the current file, but modern models can handle context from multiple files, which is a big help for cross-file references. Qwen’s multi-file template is the most explicit:

```
<|repo_name|>${reponame}
<|file_sep|>path/to/file1.ts
[file1 contents]
<|file_sep|>path/to/file2.ts
[file2 contents]
<|file_sep|>path/to/current_file.ts
<|fim_prefix|>${prefix}<|fim_suffix|>${suffix}<|fim_middle|>
```

Continue’s [Codestral template](https://github.com/continuedev/continue/blob/main/core/autocomplete/templating/AutocompleteTemplate.ts) does something similar with `[SUFFIX]` / `[PREFIX]` tokens.

Earlier approaches to multi-file context were less principled. Modern approaches tend to organize files by dependency or relevance rather than including them at random, which (as it turns out) works much better than “here are some files, good luck.”

---

## Stop Tokens and Completion Termination

Getting a model to start generating is easy. Getting it to _stop at the right place_ is where things go sideways. It’s the autocomplete equivalent of knowing when to stop talking at a party.

### Per-Model Stop Tokens

Every FIM model needs its own stop tokens. Without them, the model happily generates past the completion boundary, re-produces the suffix, or wanders off into unrelated code. It’s like a guest who keeps telling one more story after the host has already started clearing the dishes.

StarCoder and Stable Code use `<fim_prefix>`, `<fim_suffix>`, `<fim_middle>`, and `<|endoftext|>`. Qwen uses the same names but with pipes: `<|fim_prefix|>`, `<|fim_suffix|>`, `<|fim_middle|>`, `<|endoftext|>`. CodeLlama has just `<EOT>` (token id 32010). Many extensions also add `\n\n` (double newline) as a practical stop sequence for single-line completions.

### `max_tokens` Quirks

`max_tokens` interacts with completion quality in ways you might not expect. Without it, models often self-terminate cleanly. With it set, they sometimes generate repetitive filler just to use up the budget. (Models: just like contractors.) Codestral offers a `min_tokens` parameter for the opposite problem. FIM models sometimes produce zero tokens when the suffix is close to the prefix and the model isn’t sure what goes between. `min_tokens` nudges it to at least try.

Keep an eye on `finish_reason` in the response: `"stop"` means a stop token was hit (good), `"length"` means it ran into `max_tokens` and got cut off (probably incomplete).

### Token Budget Considerations

Use token-based limits, not line-based. Tokens are what the model’s context window actually cares about. The common failure mode is the model never producing an end-of-middle token within its budget, and the completion just stops mid-expression. Not a great look. Users tend to notice when their autocomplete suggests `const result = calculateTota` and then emotionally logs off.

---

## Preamble and Metadata

A few small framing choices that punch above their weight.

### File Path as Comment

Most FIM prompts prepend the file path as a comment in the target language:

```python
# Path: src/utils/parser.py
```

```typescript
// Path: src/utils/parser.ts
```

Costs a few tokens, and the model can infer a surprising amount from the path alone. What the module does, what naming conventions to expect, what framework is in use. It’s like reading the subject line of an email. Technically optional, practically essential.

### Related Snippets as Comments (FIM Mode)

In FIM mode, code from other files goes into the preamble as comments, before the actual prefix:

```typescript
// Path: src/index.ts
// --- src/utils.ts ---
// export function formatDate(date: Date): string {
//   return date.toISOString().split('T')[0];
// }
import { formatDate } from "./utils";
// ... rest of prefix
```

This is elegant. The related snippets are just part of the “prefix” as far as the model is concerned. The FIM structure stays clean, and you still get cross-file context. No XML, no special tokens, just comments.

### Structured XML Context (Chat Mode)

In chat mode, structured data works better than comments:

```xml
<related_context>
--- src/utils.ts ---
export function formatDate(date: Date): string { ... }
</related_context>
```

---

## Choosing a Model

This is the part that surprises most people. For inline autocomplete, smaller specialized models consistently beat the big general-purpose ones. It’s not even close.

On the open-source side, Qwen2.5-Coder in the 1.5B and 7B sizes tops its own FIM benchmarks[^13] and is Continue’s recommended open model.[^14] For closed models, Codestral[^15] and Mercury Coder[^16] lead Continue’s recommendations.[^14] The optimal parameter range is 1.5B–7B; Continue’s docs say “most state-of-the-art autocomplete models are no more than 10B parameters, and increasing beyond this does not significantly improve performance.”[^3] Closed models are slightly better than open models per Continue’s benchmarks,[^4] but the gap is small. And chat models for autocomplete? Don’t. They lack FIM training and [“will often perform poorly even with extensive prompting.”](https://github.com/continuedev/continue/blob/32d7ba280f4cbb0052d9d07786865c8ebebea8f1/docs/customize/model-roles/autocomplete.mdx) (Continue’s words, not ours.) This is covered in Section 3 and the news hasn’t improved.

For production use where you need sub-500ms responses, the sweet spot is a 1–7B FIM-trained model paired with good context gathering. The context gathering matters more than the model size — a well-fed small model beats a starved large one every time. It’s the “eat your vegetables” of ML engineering: unglamorous, effective, and suspiciously easy to postpone.

---

## References

### Open-Source Implementations

- [Continue.dev AutocompleteTemplate.ts](https://github.com/continuedev/continue/blob/main/core/autocomplete/templating/AutocompleteTemplate.ts)
- [Continue.dev Context Selection](https://docs.continue.dev/ide-extensions/autocomplete/context-selection)
- [Continue.dev Root Path Context](https://web.archive.org/web/20251118163602/https://blog.continue.dev/root-path-context-the-secret-ingredient-in-continues-autocomplete-prompt/)
- [Tabby Code Completion Service (DeepWiki)](https://deepwiki.com/TabbyML/tabby/3.2-code-completion-service)
- [Cody Autocomplete](https://sourcegraph.com/docs/cody/capabilities/autocomplete)
- [Cody Context Architecture](https://sourcegraph.com/blog/how-cody-understands-your-codebase)
- [The Lifecycle of a Code AI Completion (Sourcegraph)](https://sourcegraph.com/blog/the-lifecycle-of-a-code-ai-completion)

### Model Documentation

- [DeepSeek FIM Completion API](https://api-docs.deepseek.com/guides/fim_completion)
- [Mistral Codestral FIM endpoint](https://docs.mistral.ai/api/endpoint/fim)
- [Qwen2.5-Coder FIM (DeepWiki)](https://deepwiki.com/QwenLM/Qwen2.5-Coder/2.2-fill-in-the-middle)
- [How to Prompt Code Llama (Ollama)](https://ollama.com/blog/how-to-prompt-code-llama)
- [StarCoder2 FIM Instructions](https://huggingface.co/bigcode/starcoder2-15b/discussions/6)

### Further Readings

- [Efficient Training of Language Models to Fill in the Middle (Bavarian et al., 2022)](https://arxiv.org/abs/2207.14255) — The foundational FIM paper. PSM/SPM formats, FIM rate optimization
- [Improving FIM Code Completions via Context & Curriculum Based Learning (2024)](https://arxiv.org/abs/2412.16589) — Repository-level context, curriculum learning for FIM, 6.25% gain at 1B vs 1.25% at 7B
- [Evaluation of LLMs on Syntax-Aware Code Fill-in-the-Middle Tasks (2024)](https://arxiv.org/abs/2403.04814) — SAFIM benchmark, syntax-aware post-processing evaluation (ICML 2024 Oral)
- [Structure-Aware Fill-in-the-Middle Pretraining for Code (2025)](https://arxiv.org/abs/2506.00204) — AST-FIM training method, up to 5pt improvement from AST-aligned masking
- [Horizon-Length Prediction: Advancing FIM Capabilities (Ding et al., 2024)](https://arxiv.org/abs/2410.03103) — HLP training objective, up to 24% FIM improvement
- [Context Composing for Full Line Code Completion (2024)](https://arxiv.org/abs/2402.09230) — File path context, token budget optimization, 40% quality increase from 384→1536 token context (ICSE 2024 IDE workshop; DOI: 10.1145/3643796.3648446)
- [Prompt-based Code Completion via Multi-Retrieval Augmented Generation (2024)](https://arxiv.org/html/2405.07530v1) — RAG for code completion
- [Bridging Developer Instructions and Code Completion Through IFIM (Sun et al., 2025)](https://arxiv.org/abs/2509.24637) — Instruction-aware FIM, intent accuracy improvements

### References

[^1]: Ding, Yifeng, et al. “Horizon-Length Prediction: Advancing Fill-in-the-Middle Capabilities for Code Generation with Lookahead Planning.” _arXiv_, 2024, https://arxiv.org/abs/2410.03103.

[^2]: Gong, Linyuan, et al. “Structure-Aware Fill-in-the-Middle Pretraining for Code.” _arXiv_, 2025, https://arxiv.org/abs/2506.00204.

[^3]: Continue.dev. “Autocomplete Deep Dive.” _GitHub_, https://github.com/continuedev/continue/blob/cbb705427f9e90f373cb0d12c904bb95beaa8566/docs/customize/deep-dives/autocomplete.mdx. Accessed 1 Mar. 2026.

[^4]: Continue.dev. “Autocomplete Model Roles.” _Continue Documentation_, https://docs.continue.dev/customize/model-roles/autocomplete. Accessed 1 Mar. 2026.

[^6]: BigCode. “StarCoder2 FIM Instructions.” _Hugging Face_, https://huggingface.co/bigcode/starcoder2-15b/discussions/6. Accessed 1 Mar. 2026.

[^7]: Meta. “CodeLlama Tokenizer Source.” _GitHub_, https://github.com/meta-llama/codellama/blob/main/llama/tokenizer.py. Accessed 1 Mar. 2026.

[^8]: DeepSeek. “FIM Completion API.” _DeepSeek API Docs_, https://api-docs.deepseek.com/guides/fim_completion. Accessed 1 Mar. 2026.

[^9]: Mistral AI. “FIM Endpoint.” _Mistral API Documentation_, https://docs.mistral.ai/api/endpoint/fim. Accessed 1 Mar. 2026.

[^10]: Stability AI. “Stable Code 3B.” _Hugging Face_, https://huggingface.co/stabilityai/stable-code-3b. Accessed 1 Mar. 2026.

[^11]: Z.ai. “CodeGeeX4 Infilling Guideline.” _GitHub_, https://github.com/zai-org/CodeGeeX4/blob/main/guides/Infilling_guideline.md. Accessed 1 Mar. 2026.

[^12]: GitHub. “Responsible Use of GitHub Copilot Inline Suggestions.” _GitHub Docs_, https://docs.github.com/en/copilot/responsible-use/copilot-code-completion. Accessed 1 Mar. 2026.

[^13]: Hui, Binyuan, et al. “Qwen2.5-Coder Technical Report.” _arXiv_, 2024, https://arxiv.org/abs/2409.12186.

[^14]: Continue.dev. “Autocomplete Model Setup.” _Continue Documentation_, https://docs.continue.dev/ide-extensions/autocomplete/model-setup. Accessed 1 Mar. 2026.

[^15]: Mistral AI. “Codestral 25.01.” _Mistral AI News_, 2025, https://mistral.ai/news/codestral-2501.

[^16]: Khanna, Samar, et al. “Mercury: Ultra-Fast Language Models Based on Diffusion.” _arXiv_, 2025, Table 3, https://arxiv.org/abs/2506.17298.

[^17]: DeepSeek. “deepseek-coder-1.3b-base Tokenizer.” _Hugging Face_, tokens 32015–32017, https://huggingface.co/deepseek-ai/deepseek-coder-1.3b-base/raw/main/tokenizer.json. Accessed 1 Mar. 2026.

[^18]: Gong, Linyuan, et al. “Evaluation of LLMs on Syntax-Aware Code Fill-in-the-Middle Tasks.” _Proceedings of the 41st International Conference on Machine Learning (ICML 2024)_, Oral presentation, 2024. Preprint: _arXiv_, https://arxiv.org/abs/2403.04814.

[^19]: Guo, Tianyu, et al. “EFIM: Efficient Serving of LLMs for Infilling Tasks with Improved KV Cache Reuse.” _arXiv_, 2025, Section 2.2: “changes to the tail of the prefix invalidate the KV cache of the suffix” in PSM. https://arxiv.org/abs/2505.21889.

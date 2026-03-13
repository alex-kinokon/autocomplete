# Autocomplete

[Français](README.fr.md)

VSCode extension that provides inline completions using any OpenAI-compatible API endpoint.

This is not an agentic coding extension. It provides autocompletion and only autocompletion.

## Setup

```sh
pnpm install
pnpm run build
```

To test locally, use the “Run Extension” launch configuration (Run and Debug panel) to open an Extension Development Host. Or package as a VSIX:

```sh
pnpm run package
code --install-extension *.vsix
# or if you use VSCodium
codium --install-extension *.vsix
```

## Configuration

All settings are under `autocomplete.*` in VSCode settings. The endpoint defaults to `http://localhost:11434/v1`, so you only need to set a model:

```json
{
  "autocomplete.model": "qwen2.5-coder:1.5b"
}
```

Or use a different endpoint:

```json
{
  "autocomplete.endpoint": "http://localhost:8000/v1",
  "autocomplete.model": "deepseek-coder"
}
```

### FIM (Fill-in-the-Middle)

FIM uses the `/completions` endpoint and sends both the code before and after the cursor, producing better results with models that support it. Models that only accept a raw prompt also use `/completions`; other models fall back to `/chat/completions`.

By default, `autocomplete.fim.mode` is `"auto"` which auto-detects the best request mode. The extension first checks whether the server is Ollama; if so, it probes the model’s capabilities and template to choose between FIM, plain completion, and chat. Non-Ollama servers skip this probe and default to chat mode. You can also set the mode explicitly:

**Server-managed** (Ollama, LM Studio) -- the server applies its own FIM template:

```json
{
  "autocomplete.endpoint": "http://localhost:11434/v1",
  "autocomplete.model": "qwen2.5-coder:1.5b",
  "autocomplete.fim.mode": "server-managed"
}
```

**Manual token embedding** (vLLM, llama.cpp) -- for servers that expect raw FIM tokens in the prompt:

```json
{
  "autocomplete.endpoint": "http://localhost:8000/v1",
  "autocomplete.model": "deepseek-coder",
  "autocomplete.fim.mode": "custom",
  "autocomplete.fim.prefix": "<fim_prefix>",
  "autocomplete.fim.suffix": "<fim_suffix>",
  "autocomplete.fim.middle": "<fim_middle>"
}
```

Common FIM token formats for custom mode:

| Model     | prefix             | suffix             | middle             |
| --------- | ------------------ | ------------------ | ------------------ |
| DeepSeek  | `<fim_prefix>`     | `<fim_suffix>`     | `<fim_middle>`     |
| CodeLlama | `<PRE>`            | `<SUF>`            | `<MID>`            |
| StarCoder | `<fim_prefix>`     | `<fim_suffix>`     | `<fim_middle>`     |
| Qwen      | `<\|fim_prefix\|>` | `<\|fim_suffix\|>` | `<\|fim_middle\|>` |

### All settings

| Setting                     | Type     | Default                     | Description                                          |
| --------------------------- | -------- | --------------------------- | ---------------------------------------------------- |
| `autocomplete.enable`       | boolean  | `true`                      | Enable/disable the extension                         |
| `autocomplete.debug`        | boolean  | `false`                     | Log full request/response details to output channel  |
| `autocomplete.endpoint`     | string   | `http://localhost:11434/v1` | OpenAI-compatible API base URL                       |
| `autocomplete.model`        | string   |                             | Model identifier                                     |
| `autocomplete.maxTokens`    | number   | `256`                       | Maximum tokens in the completion response            |
| `autocomplete.temperature`  | number   | `0.2`                       | Sampling temperature                                 |
| `autocomplete.stop`         | string[] | `["\n\n"]`                  | Stop sequences                                       |
| `autocomplete.fim.mode`     | string   | `"auto"`                    | `"auto"`, `"off"`, `"server-managed"`, or `"custom"` |
| `autocomplete.fim.prefix`   | string   |                             | FIM prefix token (custom mode)                       |
| `autocomplete.fim.suffix`   | string   |                             | FIM suffix token (custom mode)                       |
| `autocomplete.fim.middle`   | string   |                             | FIM middle token (custom mode)                       |
| `autocomplete.debounceMs`   | number   | `300`                       | Delay in ms before sending a request                 |
| `autocomplete.contextLines` | number   | `100`                       | Lines of context around the cursor                   |
| `autocomplete.systemPrompt` | string   |                             | Custom system prompt for chat completions            |
| `autocomplete.excludeFiles` | string[] | `[]`                        | Additional glob patterns for files to exclude        |

Files matching `.env`, `.env.*`, `.npmrc`, `.pypirc`, `.netrc`, `.pgpass`, `*.pem`, `*.key`, `*.p12`, `*.pfx`, `*.jks`, `*.keystore`, and files inside `.ssh/`, `.aws/`, or `.gnupg/` directories are always excluded. Use `autocomplete.excludeFiles` to add extra patterns (e.g. `["*.log", "secrets.yaml"]`).

Commands (palette): `Autocomplete: Enable`, `Autocomplete: Disable`, `Autocomplete: Select Model`, `Autocomplete: Select Model (Workspace)`, `Autocomplete: Set API Key`, `Autocomplete: Clear API Key`. Select Model fetches the model list from any OpenAI-compatible server via `/v1/models`, and shows additional details (parameter size, quantization, disk size) when connected to Ollama.

## How it works

As you type, the extension:

1. Waits for the debounce delay
2. Extracts code context (prefix/suffix) around the cursor
3. Sends a request to the configured endpoint
4. Displays the response as an inline suggestion

Requests are automatically cancelled when you continue typing. Results are cached by cursor context (up to 75 entries).

## License

GNU General Public License v3.0 or later.

## Development

```sh
pnpm build          # bundle to dist/
pnpm watch          # rebuild on change
pnpm typecheck      # run tsc --noEmit
pnpm lint           # run eslint
pnpm lint:fix       # run eslint --fix
pnpm test           # run vitest
```

### Tree-sitter WASM compatibility

The extension uses `web-tree-sitter` to load prebuilt grammar WASMs from `tree-sitter-wasms`. These two packages must use compatible tree-sitter ABI versions or grammar loading will silently fail at runtime.

`tree-sitter-wasms@0.1.x` builds grammars with `tree-sitter-cli@0.20.x`. `web-tree-sitter@0.26+` introduced a breaking ABI change and cannot load these grammars. `web-tree-sitter` is pinned to `0.25.10` for this reason. Do not upgrade it without verifying grammar loading still works.

### Known limitations

- `autocomplete.debug` reads the global/workspace-aggregate configuration without a resource URI. In multi-root workspaces with per-folder overrides, debug logging may not respect the active document’s folder-level setting. Making `log.debug()` resource-aware would require threading a document URI through every call site.
- Completion cache keys are based on the current document’s URI and surrounding text only. Edits in other files that change cross-file context (related snippets, definition snippets) are not reflected in the cache key, so a stale cached completion can be served until the local text changes or the LRU cache evicts.
- Definition snippet de-duplication uses workspace-relative paths. In multi-root workspaces, different files with identical relative paths (e.g. `src/utils.ts` in two roots) can collide, causing one to be silently skipped.

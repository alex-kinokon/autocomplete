import * as vscode from "vscode";

import {
  clearApiKey,
  clearServerCaches,
  getSetting,
  initSecrets,
  setApiKey,
} from "./config.ts";
import { DefinitionCache } from "./definition-cache.ts";
import { EditTracker } from "./edit-tracker.ts";
import * as log from "./log.ts";
import { selectModel } from "./models.ts";
import { AutocompleteProvider } from "./provider.ts";
import { SymbolCache } from "./symbol-cache.ts";
import { ParserPool } from "./tree-sitter/parser-pool.ts";

export function activate(context: vscode.ExtensionContext): void {
  log.initLog(context);
  initSecrets(context.secrets);
  log.info("Activating extension");

  if (getSetting("debug")) {
    log.warn("Debug mode is enabled. Verbose logging may affect performance");
    void vscode.window.showWarningMessage(
      vscode.l10n.t(
        "Autocomplete: debug mode is enabled. Disable it when not troubleshooting."
      )
    );
  }

  const editTracker = new EditTracker();
  const parserPool = new ParserPool(context.extensionUri);
  const definitionCache = new DefinitionCache();
  const symbolCache = new SymbolCache();
  const provider = new AutocompleteProvider(
    editTracker,
    parserPool,
    definitionCache,
    symbolCache
  );

  context.subscriptions.push(
    editTracker,
    parserPool,
    definitionCache,
    symbolCache,
    vscode.languages.registerInlineCompletionItemProvider({ pattern: "**" }, provider),
    vscode.commands.registerCommand("autocomplete.enable", async () => {
      await vscode.workspace
        .getConfiguration("autocomplete")
        .update("enable", true, vscode.ConfigurationTarget.Global);
    }),
    vscode.commands.registerCommand("autocomplete.disable", async () => {
      await vscode.workspace
        .getConfiguration("autocomplete")
        .update("enable", false, vscode.ConfigurationTarget.Global);
    }),
    vscode.commands.registerCommand("autocomplete.selectModel", () =>
      selectModel(vscode.ConfigurationTarget.Global)
    ),
    vscode.commands.registerCommand("autocomplete.selectModelWorkspace", () =>
      selectModel(vscode.ConfigurationTarget.Workspace)
    ),
    vscode.commands.registerCommand("autocomplete.setApiKey", async () => {
      const key = await vscode.window.showInputBox({
        title: vscode.l10n.t("Set API Key"),
        prompt: vscode.l10n.t("Enter your API key for authenticated endpoints"),
        password: true,
        ignoreFocusOut: true,
      });
      if (key !== undefined) {
        await setApiKey(key);
        void vscode.window.showInformationMessage(
          vscode.l10n.t("Autocomplete: API key saved.")
        );
      }
    }),
    vscode.commands.registerCommand("autocomplete.clearApiKey", async () => {
      await clearApiKey();
      void vscode.window.showInformationMessage(
        vscode.l10n.t("Autocomplete: API key cleared.")
      );
    }),
    vscode.workspace.onDidChangeConfiguration(e => {
      if (e.affectsConfiguration("autocomplete")) {
        log.info("Configuration changed, clearing caches");
        provider.clearCache();
        clearServerCaches();
      }
    })
  );
}

export function deactivate(): void {
  log.info("Deactivating extension");
}

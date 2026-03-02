/* eslint-disable @typescript-eslint/require-await */
import { vi } from "vitest";
import type * as vscode from "vscode";

import type { LanguageId } from "../context";

function createWorkspaceConfiguration(): vscode.WorkspaceConfiguration {
  return {
    get: vi.fn(<T>(_section: string, defaultValue?: T): T | undefined => defaultValue),
    has: vi.fn(() => false),
    inspect: vi.fn(() => undefined),
    update: vi.fn(async () => undefined),
  };
}

const getConfiguration: typeof vscode.workspace.getConfiguration = vi.fn(() =>
  createWorkspaceConfiguration()
);
const getWorkspaceFolder: typeof vscode.workspace.getWorkspaceFolder = vi.fn(
  () => undefined
);
const asRelativePath: typeof vscode.workspace.asRelativePath = vi.fn(
  (pathOrUri: string | vscode.Uri) => String(pathOrUri)
);

const onDidChangeTextDocument: typeof vscode.workspace.onDidChangeTextDocument = vi.fn(
  () => ({ dispose: vi.fn() })
) as unknown as typeof vscode.workspace.onDidChangeTextDocument;

const onDidChangeConfiguration: typeof vscode.workspace.onDidChangeConfiguration = vi.fn(
  () => ({
    dispose: vi.fn(),
  })
) as unknown as typeof vscode.workspace.onDidChangeConfiguration;

const openTextDocument: typeof vscode.workspace.openTextDocument = vi.fn(
  async () =>
    ({
      uri: { toString: () => "file:///mock.ts", scheme: "file", fsPath: "/mock.ts" },
      languageId: "typescript",
      version: 1,
      lineCount: 1,
      getText: () => "",
      lineAt: () => ({ text: "" }),
    }) as unknown as vscode.TextDocument
) as unknown as typeof vscode.workspace.openTextDocument;

export const workspace: Pick<
  typeof vscode.workspace,
  | "asRelativePath"
  | "getConfiguration"
  | "getWorkspaceFolder"
  | "onDidChangeConfiguration"
  | "onDidChangeTextDocument"
  | "openTextDocument"
  | "workspaceFolders"
> = {
  getConfiguration,
  getWorkspaceFolder,
  asRelativePath,
  onDidChangeTextDocument,
  onDidChangeConfiguration,
  openTextDocument,
  workspaceFolders: [],
};

function createOutputChannel(name: string): vscode.OutputChannel {
  return {
    name,
    append: vi.fn(),
    appendLine: vi.fn(),
    replace: vi.fn(),
    clear: vi.fn(),
    show: vi.fn(),
    hide: vi.fn(),
    dispose: vi.fn(),
  };
}

function createLogOutputChannel(name: string): vscode.LogOutputChannel {
  return {
    ...createOutputChannel(name),
    logLevel: 1,
    onDidChangeLogLevel: vi.fn(() => ({ dispose: vi.fn() })),
    trace: vi.fn(),
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };
}

function createOutputChannelForWindow(
  name: string,
  languageId?: LanguageId
): vscode.OutputChannel;
function createOutputChannelForWindow(
  name: string,
  options: { log: true }
): vscode.LogOutputChannel;
function createOutputChannelForWindow(
  name: string,
  arg?: string | { log?: true }
): vscode.LogOutputChannel | vscode.OutputChannel {
  if (typeof arg === "object" && arg.log) {
    return createLogOutputChannel(name);
  }
  return createOutputChannel(name);
}

function showMessage(
  message: string,
  ...items: readonly vscode.MessageItem[]
): Promise<vscode.MessageItem | undefined>;
function showMessage<T extends string>(
  message: string,
  ...items: readonly T[]
): Promise<T | undefined>;
function showMessage<T extends string>(
  message: string,
  options: vscode.MessageOptions,
  ...items: readonly T[]
): Promise<T | undefined>;
function showMessage<T extends vscode.MessageItem>(
  message: string,
  ...items: readonly T[]
): Promise<T | undefined>;
function showMessage<T extends vscode.MessageItem>(
  message: string,
  options: vscode.MessageOptions,
  ...items: readonly T[]
): Promise<T | undefined>;
async function showMessage<T extends string | vscode.MessageItem>(
  message: string,
  ...args: readonly unknown[]
): Promise<T | vscode.MessageItem | undefined> {
  const [, ...items] =
    typeof args[0] === "object" && args[0] !== null && !Array.isArray(args[0])
      ? args
      : [undefined, ...args];
  return (items[0] as T | vscode.MessageItem | undefined) ?? (message as T);
}

function localize(message: string, ...args: Array<boolean | number | string>): string;
function localize(
  message: string,
  args: Record<string, boolean | number | string>
): string;
function localize(options: {
  message: string;
  args?: Array<boolean | number | string> | Record<string, boolean | number | string>;
  comment: string | string[];
}): string;
function localize(
  messageOrOptions:
    | string
    | {
        message: string;
        args?:
          | Array<boolean | number | string>
          | Record<string, boolean | number | string>;
        comment: string | string[];
      },
  ...rest: readonly unknown[]
): string {
  const message =
    typeof messageOrOptions === "string" ? messageOrOptions : messageOrOptions.message;

  const argsSource =
    typeof messageOrOptions === "string" ? rest[0] : messageOrOptions.args;
  if (Array.isArray(argsSource)) {
    return argsSource.reduce(
      (acc, value, index) => acc.replace(`{${index}}`, String(value)),
      message
    );
  }
  if (argsSource && typeof argsSource === "object") {
    let result = message;
    for (const [key, value] of Object.entries(argsSource)) {
      result = result.replace(`{${key}}`, String(value));
    }
    return result;
  }
  return message;
}

export const window: Pick<
  typeof vscode.window,
  | "createOutputChannel"
  | "showErrorMessage"
  | "showInformationMessage"
  | "showQuickPick"
  | "visibleTextEditors"
> = {
  visibleTextEditors: [],
  createOutputChannel: vi.fn(
    createOutputChannelForWindow
  ) as unknown as typeof vscode.window.createOutputChannel,
  showErrorMessage: vi.fn(
    showMessage
  ) as unknown as typeof vscode.window.showErrorMessage,
  showInformationMessage: vi.fn(
    showMessage
  ) as unknown as typeof vscode.window.showInformationMessage,
  showQuickPick: vi.fn(async () => undefined) as typeof vscode.window.showQuickPick,
};

export const languages: Pick<
  typeof vscode.languages,
  "registerInlineCompletionItemProvider"
> = {
  registerInlineCompletionItemProvider: vi.fn(() => ({
    dispose: vi.fn(),
  })) as typeof vscode.languages.registerInlineCompletionItemProvider,
};

export const commands: Pick<
  typeof vscode.commands,
  "executeCommand" | "registerCommand"
> = {
  registerCommand: vi.fn(() => ({
    dispose: vi.fn(),
  })) as typeof vscode.commands.registerCommand,
  executeCommand: vi.fn(async () => []) as typeof vscode.commands.executeCommand,
};

export class Position implements vscode.Position {
  constructor(
    readonly line: number,
    readonly character: number
  ) {}

  isBefore(other: vscode.Position): boolean {
    return this.compareTo(other) < 0;
  }

  isBeforeOrEqual(other: vscode.Position): boolean {
    return this.compareTo(other) <= 0;
  }

  isAfter(other: vscode.Position): boolean {
    return this.compareTo(other) > 0;
  }

  isAfterOrEqual(other: vscode.Position): boolean {
    return this.compareTo(other) >= 0;
  }

  isEqual(other: vscode.Position): boolean {
    return this.line === other.line && this.character === other.character;
  }

  compareTo(other: vscode.Position): number {
    if (this.line === other.line) {
      return this.character - other.character;
    }
    return this.line - other.line;
  }

  translate(lineDelta?: number, characterDelta?: number): Position;
  translate(change: { lineDelta?: number; characterDelta?: number }): Position;
  translate(
    lineDeltaOrChange: number | { lineDelta?: number; characterDelta?: number } = 0,
    characterDelta = 0
  ): Position {
    if (typeof lineDeltaOrChange === "number") {
      return new Position(this.line + lineDeltaOrChange, this.character + characterDelta);
    }
    return new Position(
      this.line + (lineDeltaOrChange.lineDelta ?? 0),
      this.character + (lineDeltaOrChange.characterDelta ?? 0)
    );
  }

  with(line?: number, character?: number): Position;
  with(change: { line?: number; character?: number }): Position;
  with(
    lineOrChange?: number | { line?: number; character?: number },
    character?: number
  ): Position {
    if (typeof lineOrChange === "number" || lineOrChange === undefined) {
      const nextLine = lineOrChange ?? this.line;
      const nextChar = character ?? this.character;
      return nextLine === this.line && nextChar === this.character
        ? this
        : new Position(nextLine, nextChar);
    }
    const nextLine = lineOrChange.line ?? this.line;
    const nextChar = lineOrChange.character ?? this.character;
    return nextLine === this.line && nextChar === this.character
      ? this
      : new Position(nextLine, nextChar);
  }
}

export class Range implements vscode.Range {
  readonly start: Position;
  readonly end: Position;

  constructor(start: Position, end: Position);
  constructor(
    startLine: number,
    startCharacter: number,
    endLine: number,
    endCharacter: number
  );
  constructor(
    startOrLine: number | Position,
    startCharacterOrEnd: number | Position,
    endLine?: number,
    endCharacter?: number
  ) {
    const startPosition =
      typeof startOrLine === "number"
        ? new Position(startOrLine, startCharacterOrEnd as number)
        : startOrLine;
    const endPosition =
      typeof startOrLine === "number"
        ? new Position(
            endLine ?? startOrLine,
            endCharacter ?? (startCharacterOrEnd as number)
          )
        : (startCharacterOrEnd as Position);

    if (startPosition.isBeforeOrEqual(endPosition)) {
      this.start = startPosition;
      this.end = endPosition;
    } else {
      this.start = endPosition;
      this.end = startPosition;
    }
  }

  get isEmpty(): boolean {
    return this.start.isEqual(this.end);
  }

  get isSingleLine(): boolean {
    return this.start.line === this.end.line;
  }

  contains(positionOrRange: Position | Range): boolean {
    if (positionOrRange instanceof Range) {
      return this.contains(positionOrRange.start) && this.contains(positionOrRange.end);
    }
    return (
      positionOrRange.isAfterOrEqual(this.start) &&
      positionOrRange.isBeforeOrEqual(this.end)
    );
  }

  isEqual(other: Range): boolean {
    return this.start.isEqual(other.start) && this.end.isEqual(other.end);
  }

  intersection(other: Range): Range | undefined {
    const start = this.start.isAfter(other.start) ? this.start : other.start;
    const end = this.end.isBefore(other.end) ? this.end : other.end;
    return start.isAfter(end) ? undefined : new Range(start, end);
  }

  union(other: Range): Range {
    const start = this.start.isBefore(other.start) ? this.start : other.start;
    const end = this.end.isAfter(other.end) ? this.end : other.end;
    return new Range(start, end);
  }

  with(start?: Position, end?: Position): Range;
  with(change: { start?: Position; end?: Position }): Range;
  with(
    startOrChange?: Position | { start?: Position; end?: Position },
    end?: Position
  ): Range {
    if (startOrChange instanceof Position || startOrChange === undefined) {
      const nextStart = startOrChange ?? this.start;
      const nextEnd = end ?? this.end;
      return nextStart === this.start && nextEnd === this.end
        ? this
        : new Range(nextStart, nextEnd);
    }
    const nextStart = startOrChange.start ?? this.start;
    const nextEnd = startOrChange.end ?? this.end;
    return nextStart === this.start && nextEnd === this.end
      ? this
      : new Range(nextStart, nextEnd);
  }
}

export class InlineCompletionItem implements vscode.InlineCompletionItem {
  filterText?: string;
  command?: vscode.Command;
  constructor(
    readonly insertText: string | vscode.SnippetString,
    readonly range?: Range
  ) {}
}

export const Uri: Pick<typeof vscode.Uri, "joinPath"> = {
  joinPath: vi.fn() as typeof vscode.Uri.joinPath,
};

export const ConfigurationTarget: typeof vscode.ConfigurationTarget = {
  Global: 1,
  Workspace: 2,
  WorkspaceFolder: 3,
};

export const l10n: Pick<typeof vscode.l10n, "t"> = {
  t: vi.fn(localize) as unknown as typeof vscode.l10n.t,
};

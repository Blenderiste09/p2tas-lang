import {
	createConnection,
	ProposedFeatures,
	InitializeParams,
	CompletionItem,
	CompletionItemKind,
	TextDocumentPositionParams,
	TextDocumentSyncKind,
	InsertTextFormat,
	MarkupKind
} from 'vscode-languageserver/node';

import { TASScript } from './tas-script/tasScript';
import { TASTool } from './tas-script/tasTool';
import { CompletionItemDeclaration, endCompletion, startCompletion, startTypes } from './tas-script/util';

const connection = createConnection(ProposedFeatures.all);
const documents: Map<string, TASScript> = new Map();

connection.onInitialize((params: InitializeParams) => {
	return {
		capabilities: {
			textDocumentSync: TextDocumentSyncKind.Full,
			hoverProvider: true,
			completionProvider: {
				triggerCharacters: [" ", ";"]
			}
		}
	};
});

connection.onDidOpenTextDocument((params) => {
	const tasScript = new TASScript();
	const diagnostics = tasScript.parse(params.textDocument.text);
	connection.sendDiagnostics({ uri: params.textDocument.uri, diagnostics });

	documents.set(params.textDocument.uri, tasScript);
});

connection.onDidChangeTextDocument((params) => {
	params.contentChanges.forEach((change) => {
		const diagnostics = documents.get(params.textDocument.uri)?.parse(change.text);
		if (diagnostics)
			connection.sendDiagnostics({ uri: params.textDocument.uri, diagnostics });
	});
});

connection.onDidCloseTextDocument((params) => { documents.delete(params.textDocument.uri); });

connection.onCompletion((params: TextDocumentPositionParams): CompletionItem[] => {
	const script = documents.get(params.textDocument.uri);
	if (!script) return [];

	const line = script.lines[params.position.line];
	const lineText = line.lineText;

	let isStartOfLine = false;
	let isInFirstLine = false;
	isStartOfLine = params.position.character === 0;
	for (const scriptLine of script.lines) {
		if (!scriptLine.isComment) {
			if (scriptLine === line) isInFirstLine = true;
			break;
		}
	}

	const isComment = (line.isComment && params.position.character > (line.commentStart || 0));
	if (!(isInFirstLine || isInFirstLine) && params.position.character <= lineText.lastIndexOf('|') || isComment) return [];

	const [_, requestedToolName, toolArguments, completeTool] = getToolAndArgumentAtPosition(params.position.character, lineText);

	if (completeTool) {
		if (isStartOfLine) {
			let options: CompletionItemDeclaration[] = [];
			if (isInFirstLine) options.push(startCompletion);
			options.push(endCompletion);
			return options.map((option) => {
				return {
					label: option.name,
					kind: CompletionItemKind.Field,
					documentation: {
						kind: MarkupKind.Markdown,
						value: option.description,
					}
				};
			});
		}
		else {
			return Object.entries(TASTool.tools)!.map((tool) => {
				return {
					label: tool[0],
					kind: CompletionItemKind.Method,
					documentation: {
						kind: MarkupKind.Markdown,
						value: tool[1].description || ""
					}
				};
			});
		}
	}
	else {
		if (isInFirstLine) {
			if (requestedToolName === "start") {
				if (toolArguments.length !== 0) return [];
				return Object.entries(startTypes).map(arg => {
					return {
						label: arg[0],
						kind: CompletionItemKind.Field,
						documentation: arg[1].description
					};
				});
			}
		}

		// Tool does not exist. An error for that will already be displayed, 
		// we just can't provide completion
		if (!TASTool.tools.hasOwnProperty(requestedToolName)) return [];

		const tool = TASTool.tools[requestedToolName];
		return tool.arguments
			.filter((arg) => {
				let wasAlreadyGiven = false;
				// Check if arg was already given
				for (const toolArg of toolArguments) {
					if (arg.matcher && arg.matcher.test(toolArg)) wasAlreadyGiven = true;
					else if (arg.name === toolArg) wasAlreadyGiven = true;
				}

				// Filter out already given arguments and digit "placeholder-arguments"
				return !wasAlreadyGiven && arg.type !== TASTool.ToolArgumentType.Digit;
			})
			.map((arg) => {
				let result: CompletionItem = {
					label: arg.name,
					kind: CompletionItemKind.Field,
					documentation: {
						kind: MarkupKind.Markdown,
						value: arg.description || ""
					}
				};

				if (arg.type === TASTool.ToolArgumentType.Unit) {
					result.insertTextFormat = InsertTextFormat.Snippet
					result.insertText = `$1${arg.unit!}`;
				}

				return result;
			});
	}
});

function getToolAndArgumentAtPosition(character: number, lineText: string): [string, string, string[], boolean] {
	let index = character;
	let word = "";
	let encounteredWords: string[] = [];
	let didCompleteHoveredWord = false;
	let requestedToolName = "";
	let isWordTool: boolean | undefined;

	// Get everything after the character
	while ((lineText.charAt(index) !== ' ' && lineText.charAt(index) !== ';') && index < lineText.length) {
		word += lineText.charAt(index);
		index++;
	}

	// Get everything before the character and determine whether the word is a tool
	// If it is not, also find the tool
	index = character - 1;
	for (; index >= 0; index--) {
		const char = lineText.charAt(index);
		if (char === ' ') {
			didCompleteHoveredWord = true;
		}
		else {
			if (char === '|' || char === ';') {
				isWordTool = requestedToolName.length === 0;
				break;
			}

			if (didCompleteHoveredWord) {
				if (lineText.charAt(index + 1) === ' ') {
					if (requestedToolName.length !== 0)
						encounteredWords.push(requestedToolName);
					requestedToolName = char;
				}
				else requestedToolName = char + requestedToolName;
			}
			else word = char + word;
		}
	}

	if (isWordTool === undefined) isWordTool = requestedToolName.length === 0;

	return [word, requestedToolName, encounteredWords, isWordTool];
}

connection.onHover((params, cancellationToken, workDoneProgressReporter, resultProgressReporter) => {
	const script = documents.get(params.textDocument.uri);
	if (!script) return undefined;

	const line = script.lines[params.position.line];
	const lineText = line.lineText;
	// Check if the cursor is before the '>' and before any comments
	if (line.isComment && params.position.character > (line.commentStart || 0)) return undefined;

	if (params.position.character < lineText.indexOf('>')) {
		// Return tick count
		return { contents: [`Tick: ${line.absoluteTick}`] };
	}
	else if (lineText.split("|").length - 1 === 4 && params.position.character > lineText.lastIndexOf('|')) {
		// Return tool / argument information
		const [hoveredWord, requestedToolName, _, hoveredTool] = getToolAndArgumentAtPosition(params.position.character, lineText);

		if (hoveredTool) {
			if (!TASTool.tools.hasOwnProperty(hoveredWord)) return undefined;
			return {
				contents: TASTool.getToolDescription(hoveredWord)
			};
		}
		else {
			if (!TASTool.getToolArgument(requestedToolName, hoveredWord)) return undefined;

			return {
				contents: TASTool.getArgumentDescription(requestedToolName, hoveredWord)
			};
		}
	}

	return undefined;
});

connection.onRequest("p2tas/activeTools", (params: [any, number]) => {
	const [uri, lineNumber] = params;

	const script = documents.get(uri.external);
	if (script === undefined) return "";
	const line = script.lines[lineNumber];

	return line.activeTools.map((tool) => `${tool.tool}${tool.ticksRemaining ? ` (${tool.ticksRemaining} ticks remaining)` : ""}`).join(", ");
});

connection.onRequest("p2tas/lineTick", (params: [any, number]) => {
	const [uri, lineNumber] = params;

	const script = documents.get(uri.external);
	if (script === undefined) return "";
	const line = script.lines[lineNumber];

	return line.absoluteTick;
});

// Listen on the connection
connection.listen();
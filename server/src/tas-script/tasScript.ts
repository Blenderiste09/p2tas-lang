import { CompletionList, Diagnostic, DiagnosticSeverity, Position, Range, TextDocumentContentChangeEvent } from "vscode-languageserver";
import { scriptLineComment, createScriptLine, LineType, ScriptLine } from "./scriptLine";
import { DiagnosticCollector } from "./util";

export class TASScript {
    lines: ScriptLine[] = [];

    parse(fileText: string): Diagnostic[] {
        this.lines = [];

        const diagnosticCollector = new DiagnosticCollector();
        let didFindStart = false;

        let index = 0;
        let currentLine = 0;
        let multilineCommentsOpen = 0;
        // Stores the iterations, the tick count of the 'repeat' line and the line of the repeat statement
        let repeats: [number, number, number][] = [];
        while (index <= fileText.length) {
            let lineText = "";
            while (fileText.charAt(index) !== '\n' && index < fileText.length) {
                const char = fileText.charAt(index);
                if (char !== '\r')
                    lineText += char;
                index++;
            }

            const trimmedLineText = lineText.trim();

            index++;

            let commentLine: ScriptLine;
            [lineText, multilineCommentsOpen, commentLine] = this.removeComments(lineText, currentLine, multilineCommentsOpen, diagnosticCollector);

            let previousLine = scriptLineComment("", false);
            for (let i = this.lines.length - 1; i >= 0; i--) {
                if (!this.lines[i].isComment) {
                    previousLine = this.lines[i];
                    break;
                }
            }

            if (lineText.length === 0) {
                commentLine.activeTools = previousLine.activeTools;
                commentLine.absoluteTick = previousLine.absoluteTick;
                this.lines.push(commentLine);

                currentLine++;
                continue;
            }

            if (trimmedLineText.startsWith("start")) {
                if (didFindStart) {
                    diagnosticCollector.addDiagnosticToLine(currentLine, 0, "Multiple start lines found");
                }
                else {
                    const line = createScriptLine(LineType.Start, lineText, currentLine, previousLine, diagnosticCollector);
                    if (commentLine) line.mergeComments(commentLine)
                    this.lines.push(line);
                }

                didFindStart = true;
                currentLine++;
                continue;
            }
            else {
                if (!didFindStart) {
                    // Start was not the first statement in the file
                    diagnosticCollector.addDiagnosticToLine(currentLine, 0, "Expected 'start' statement");
                    didFindStart = true;
                    // We don't continue here, since we want to still parse the line after we've informed the user
                }
            }

            if (trimmedLineText.startsWith("repeat")) {
                const line = createScriptLine(LineType.RepeatStart, lineText, currentLine, previousLine, diagnosticCollector);
                this.lines.push(line);

                const parts = lineText.split(' ').filter((part) => part.length > 0);
                repeats.push([parts.length >= 2 ? +parts[1] : 1, previousLine.absoluteTick, currentLine]);
                currentLine++;
                continue;
            }
            else if (trimmedLineText.startsWith("end")) {
                if (repeats.length === 0) {
                    diagnosticCollector.addDiagnosticToLine(currentLine, 0, "End line outside of loop");
                    this.lines.push(new ScriptLine(lineText, LineType.End, previousLine.absoluteTick));
                    currentLine++;
                    continue;
                }

                const line = createScriptLine(LineType.End, lineText, currentLine, previousLine, diagnosticCollector);

                const [iterations, startTickCount] = repeats.pop()!;
                const loopDuration = line.absoluteTick - startTickCount;
                // Get the new absolute tick value. Iterations needs to be one less, 
                // since one iteration was already counted when parsing the lines between 'repeat' and 'end'
                line.absoluteTick += (iterations - 1) * loopDuration;

                this.lines.push(line);
                currentLine++;
                continue;
            }

            const line = createScriptLine(LineType.Framebulk, lineText, currentLine, previousLine, diagnosticCollector);
            if (commentLine) line.mergeComments(commentLine)
            this.lines.push(line);

            const activeTools = line!.activeTools;
            for (let j = 0; j < activeTools.length; j++) {
                if (activeTools[j].ticksRemaining !== undefined) {
                    activeTools[j].ticksRemaining! -= line.absoluteTick - (previousLine.type === LineType.Start ? 0 : previousLine.absoluteTick);
                    if (activeTools[j].ticksRemaining! <= 0) {
                        if (activeTools[j].tool === "autoaim") {
                            activeTools[j].startTick = undefined;
                            activeTools[j].ticksRemaining = undefined;
                            continue;
                        }

                        activeTools.splice(j, 1);
                        j--;
                    }
                }
            }

            currentLine++;
        }

        if (repeats.length > 0) {
            for (const [_, __, line] of repeats) {
                diagnosticCollector.addDiagnosticToLine(line, this.lines[line].lineText.match(/\S/)?.index || 0, "Unterminated loop");
            }
        }

        return diagnosticCollector.getDiagnostics();
    }

    removeComments(lineText: string, currentLine: number, multilineCommentsOpen: number, collector: DiagnosticCollector): [string, number, ScriptLine] {
        let resultLine = scriptLineComment(lineText, false);

        // Check for single line comments
        const singleLineCommentOpenToken = lineText.indexOf('//');
        if (singleLineCommentOpenToken !== -1) {
            resultLine.commentStart = singleLineCommentOpenToken;
            resultLine.isComment = true;

            lineText = lineText.substring(0, singleLineCommentOpenToken);
            if (lineText.length === 0) {
                // Only return if the line is empty after removing single line comments. 
                // Otherwise we want to continue with the multiline comments.
                return [lineText, multilineCommentsOpen, resultLine];
            }
        }

        const multilineCommentOpenToken = lineText.indexOf('/*');
        const multilineCommentCloseToken = lineText.indexOf('*/');
        if (multilineCommentOpenToken !== -1 && multilineCommentCloseToken === -1) {
            multilineCommentsOpen += 1;
            lineText = lineText.substring(0, multilineCommentOpenToken);

            resultLine.commentStart = multilineCommentOpenToken;
            resultLine.isComment = true;
        }
        if (multilineCommentCloseToken !== -1) {
            if (multilineCommentOpenToken === -1) {
                multilineCommentsOpen -= 1;
                resultLine.multilineCommentEnd = multilineCommentCloseToken;
                resultLine.isComment = true;

                if (multilineCommentsOpen < 0) {
                    // Comment was closed but never opened
                    collector.addDiagnostic(currentLine, multilineCommentCloseToken, multilineCommentCloseToken + 2, "Comment was never opened!");
                    return [lineText, multilineCommentsOpen, resultLine];
                }

                lineText = lineText.substring(multilineCommentCloseToken + 2);
            }
            else {
                lineText = lineText.substring(0, multilineCommentOpenToken) + lineText.substring(multilineCommentCloseToken + 2);
                resultLine.multilineCommentEnd = multilineCommentCloseToken;
                resultLine.isComment = true;
            }
        }

        if (multilineCommentOpenToken === -1 && multilineCommentCloseToken === -1 && multilineCommentsOpen > 0) {
            resultLine = scriptLineComment(lineText, true);
            lineText = "";
        }

        return [lineText, multilineCommentsOpen, resultLine!];
    }
}
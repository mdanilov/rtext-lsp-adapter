import {
    createConnection,
    Diagnostic,
    DiagnosticSeverity,
    DocumentLink,
    DocumentLinkParams,
    Position,
    ProposedFeatures,
    Range,
    SymbolInformation,
    TextDocuments,
    TextDocumentSyncKind,
    TextDocumentPositionParams,
    InsertTextFormat,
    Location,
    Hover,
    CompletionParams,
    CompletionItem,
    CompletionItemKind,
    WorkspaceSymbolParams,
    SymbolKind,
    ReferenceParams
} from "vscode-languageserver/node";

import { TextDocument } from "vscode-languageserver-textdocument";

import { Client as RTextClient } from "./rtext/client";
import * as rtext from "./rtext/protocol";
import { Context } from "./rtext/context";
import { ServerInitializationOptions } from "./options";

import { pathToFileURL } from 'url'

// Creates the LSP connection
const connection = createConnection(ProposedFeatures.all);

// Create a manager for open text documents
const documents: TextDocuments<TextDocument> = new TextDocuments(TextDocument);

// The workspace folder this server is operating on
let workspaceFolder: string | null | undefined;

// Initialization options passed by the client
let settings: ServerInitializationOptions;

let rtextClient: RTextClient;

let previousProblemFiles: string[] = [];
async function provideDiagnostics() {
    const progressReporter = await connection.window.createWorkDoneProgress();
    progressReporter.begin("ESR Automate: Loading model", 0);
    rtextClient.loadModel((progress: rtext.ProgressInformation) => {
        if ((progress.percentage != undefined) && (progress.message != undefined)) {
            progressReporter.report(progress.percentage, progress.message);
        }
        else if (progress.percentage != undefined) {
            progressReporter.report(progress.percentage);
        }
        else if (progress.message != undefined) {
            progressReporter.report(progress.message);
        }
    }).then((data) => {
        const problemFiles: string[] = [];
        data.problems.forEach((problem) => {
            const diagnostics: Diagnostic[] = [];

            function convertSeverity(severity: rtext.ProblemSeverity): DiagnosticSeverity {
                switch (severity) {
                    case rtext.ProblemSeverity.debug:
                        return DiagnosticSeverity.Hint;
                    case rtext.ProblemSeverity.error:
                    case rtext.ProblemSeverity.fatal:
                        return DiagnosticSeverity.Error;
                    case rtext.ProblemSeverity.warn:
                        return DiagnosticSeverity.Warning;
                    case rtext.ProblemSeverity.info:
                        return DiagnosticSeverity.Information;
                    default:
                        //@todo assert
                        return DiagnosticSeverity.Error;
                }
            }

            problem.problems.forEach((fileProblem) => {
                const diagnostic: Diagnostic = {
                    message: fileProblem.message,
                    range: Range.create(Position.create(fileProblem.line - 1, 0), Position.create(fileProblem.line - 1, Number.MAX_VALUE)),
                    severity: convertSeverity(fileProblem.severity),
                };

                diagnostics.push(diagnostic);
            });
            connection.sendDiagnostics({ uri: pathToFileURL(problem.file).toString(), diagnostics });
            problemFiles.push(problem.file);
        });

        previousProblemFiles.forEach((file) => {
            if (!problemFiles.includes(file)) {
                connection.sendDiagnostics({ uri: pathToFileURL(file).toString(), diagnostics: [] });
            }
        });
        previousProblemFiles = problemFiles;
    }).catch(error => {
        console.log(`Failed to load model: ${error.message}`);
    }).finally(() => { progressReporter.done(); });
}

function extractContext(document: TextDocument, position: any): Context {
    const text = document.getText(Range.create(Position.create(0, 0), Position.create(position.line, Number.MAX_VALUE)));
    const lines = text.split('\n');
    lines.pop(); // remove last `\n` added by getText
    const pos = position.character + 1; // column number start at 1 in RText protocol
    return Context.extract(lines, pos);
}

connection.onHover((params: TextDocumentPositionParams): Promise<Hover | null> | undefined => {
    const document = documents.get(params.textDocument.uri);
    if (document) {
        const ctx = extractContext(document, params.position);
        return rtextClient.getContextInformation(ctx).then((response: rtext.ContextInformationResponse) => {
            return { contents: response.desc };
        }).catch(error => {
            connection.console.error(error.message);
            return null;
        });
    }
});

connection.onReferences((params: ReferenceParams): Promise<Location[] | null> | undefined => {
    const document = documents.get(params.textDocument.uri);
    if (document) {
        const ctx = extractContext(document, params.position);
        return rtextClient.getLinkTargets(ctx).then((response: rtext.LinkTargetsResponse) => {
            let locations: Location[] = [];
            response.targets.forEach(target => {
                const range = Range.create(
                    Position.create(target.line - 1, 0),
                    Position.create(target.line - 1, Number.MAX_VALUE)
                );
                const uri = pathToFileURL(target.file).toString();
                locations.push({ uri, range });
            });
            return locations;
        }).catch(error => {
            connection.console.error(error.message);
            return null;
        });
    }
});

connection.onWorkspaceSymbol((params: WorkspaceSymbolParams): Promise<SymbolInformation[] | null> | undefined => {
    return rtextClient.findElements(params.query).then((response: rtext.FindElementsResponse) => {
        const info: SymbolInformation[] = [];
        response.elements.forEach((e) => {
            info.push({
                name: e.display,
                location: {
                    uri: pathToFileURL(e.file).toString(),
                    range: {
                        start: { line: e.line - 1, character: 0 },
                        end: { line: e.line - 1, character: Number.MAX_VALUE }
                    }
                },
                kind: SymbolKind.Null
            });
        });
        return info;
    }).catch(error => {
        connection.console.error(error.message);
        return null;
    });
});

connection.onDocumentLinks((params: DocumentLinkParams): DocumentLink[] => {
    const document = documents.get(params.textDocument.uri);
    const links: DocumentLink[] = [];
    if (document) {
        const lines: string[] = document.getText().split('\n');
        const re = /\/?\w+\/[\/\w]+\b/g;
        lines.forEach((line: string, index: number) => {
            let m;
            do {
                m = re.exec(line);
                if (m) {
                    const range = Range.create(
                        index, m.index,
                        index, m.index + m[0].length
                    );
                    const data = { textDocument: params.textDocument };
                    links.push({ range, data });
                }
            } while (m)
        });
    }
    return links;
});

connection.onDocumentLinkResolve((link: DocumentLink): Promise<DocumentLink | null> | undefined => {
    const document = documents.get(link.data.textDocument.uri);
    if (document) {
        const ctx = extractContext(document, link.range.start);
        return rtextClient.getLinkTargets(ctx).then((response: rtext.LinkTargetsResponse) => {
            if (response.targets.length > 0) {
                const target = response.targets[0];
                let url = pathToFileURL(target.file);
                url.hash = target.line.toString();
                link.target = url.toString();
            }
            return link;
        }).catch(error => {
            connection.console.error(error.message);
            return null;
        });
    }
});

connection.onCompletion((params: CompletionParams): Promise<CompletionItem[] | null> | undefined => {
    function createSnippetString(insert: string): string {
        let begin = 0;
        let snippet = "";
        while (begin != -1) {
            const pos = begin;
            begin = insert.indexOf('|', begin);
            if (pos != begin) {
                const text = insert.substring(pos, begin === -1 ? insert.length : begin);
                snippet = snippet.concat(text);
            }
            if (begin != -1) {
                let end = insert.indexOf('|', begin);
                const number = parseInt(insert.substring(begin, end));

                begin = end;
                end = insert.indexOf('|', begin);
                const name = insert.substring(begin, end);

                begin = end;
                end = insert.indexOf('|', begin);
                // eslint-disable-next-line @typescript-eslint/no-unused-vars
                const description = insert.substring(begin, end);

                begin = end;
                snippet = snippet.concat(`\$\{${number}:${name}\}`);
            }
        }
        return snippet;
    }
    const document = documents.get(params.textDocument.uri);
    if (document) {
        const ctx = extractContext(document, params.position);
        return rtextClient.getContentCompletion(ctx).then((response: rtext.ContentCompleteResponse) => {
            const items: CompletionItem[] = [];
            response.options.forEach((option) => {
                items.push({
                    insertText: createSnippetString(option.insert),
                    insertTextFormat: InsertTextFormat.Snippet,
                    label: option.display,
                    detail: option.desc,
                    kind: CompletionItemKind.Snippet
                });
            });
            return items;
        }).catch(error => {
            connection.console.error(error.message);
            return null;
        });
    }
});

connection.onInitialize((params) => {
    workspaceFolder = params.rootPath;
    connection.console.log(`[Server(${process.pid}) ${workspaceFolder}] Started and initialize received`);

    settings = params.initializationOptions;
    rtextClient = new RTextClient(settings.rtextConfig, () => { provideDiagnostics(); });

    return {
        capabilities: {
            textDocumentSync: {
                change: TextDocumentSyncKind.Full,
                openClose: true,
            },
            referencesProvider: true,
            completionProvider: {
                resolveProvider: false
            },
            documentLinkProvider: {
                resolveProvider: true
            },
            hoverProvider: settings.hoverProvider,
            workspaceSymbolProvider: true
        },
    };
});

connection.onInitialized(async () => {
    connection.console.log(`[Server(${process.pid}) ${workspaceFolder}] Initialized received`);
    if (workspaceFolder) {
        rtextClient.start().then(() => {
            provideDiagnostics();
        }).catch((error: Error) => {
            connection.window.showErrorMessage(error.message);
        });
    }
});

connection.onDidChangeWatchedFiles(() => {
    provideDiagnostics();
});

// Make the text document manager listen on the connection
// for open, change and close text document events
documents.listen(connection);

// Listen on the connection
connection.listen();

connection.onShutdown(() => {
    rtextClient.stop();
});

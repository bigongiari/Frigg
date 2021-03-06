'use strict';

import * as fs from 'fs';
import * as path from 'path';
import {homedir} from 'os';
import * as vscode from 'vscode';
import Params, {validateParamsMap, ParamsMap} from './params';
import ReplacementProvider from './replacementProvider';
import InterfaceBuilder from './interfaceBuilder';
import {mkFileDirRecursive} from './utils';

const request = require('request');

export function activate(context: vscode.ExtensionContext) {

    const replacementProvider = new ReplacementProvider();

    const providerRegistrations = vscode.Disposable.from(
        vscode.workspace.registerTextDocumentContentProvider(ReplacementProvider.scheme, replacementProvider)
    );

    const replaceParamsCmd = vscode.commands.registerTextEditorCommand('frigg.replaceParameters', editor => {
        replaceParams(editor.document, nextColumn(editor));
    });

    const replaceParamsToFileCmd = vscode.commands.registerTextEditorCommand('frigg.replaceParamsToFile', editor => {
        replaceParams(editor.document, nextColumn(editor), false);
    });

    const downloadTemplatesCmd = vscode.commands.registerCommand('frigg.downloadTemplates', () => {
        let resource = vscode.window.activeTextEditor ? vscode.window.activeTextEditor.document.uri : undefined;
        downloadTemplates(resource).then(files => {}, err => {
            if (err !== undefined && err !== null && err !== '') {
                vscode.window.showErrorMessage(err);
            }
        });
    });

    // TODO: add command to show template folder / files

    const generateScriptFromParamsCmd = vscode.commands.registerTextEditorCommand('frigg.generateScriptFromParams', editor => {
        // Find template folder, if not set ask to run download
        // Pick template file from folder, or any
        // ...
        
        let paramsMap = validateParamsMap(Params.parseParameters(editor.document.getText()));
        if (paramsMap === null) {
            vscode.window.showErrorMessage('not a valid parameter file');
            return;
        }

        let resource = editor.document.uri;
        let paramsFsPath = resource.fsPath;
        let defaultTemplate = getDefaultTemplateFile(paramsFsPath);
        let otherTemplates = discoverTemplateFiles(resource).then((_) => _, (_) => downloadTemplates(resource));
        askForFile(defaultTemplate, otherTemplates, 'please select a template file ...', false).then(templateFile => {
            if (templateFile === undefined) {
                return;
            }

            let column = nextColumn(editor);
            fs.exists(templateFile, exists => {
                if (!exists) {
                    mkFileDirRecursive(path.dirname(templateFile));
                    fs.writeFile(templateFile, JSON.stringify(InterfaceBuilder.getDefaultConfig(), null, 2), (err) => {
                        if (err !== null) {
                            vscode.window.showErrorMessage(`can't write to template file ${templateFile}: ${err}`);
                            return;
                        }
                    });
                    vscode.workspace.openTextDocument(templateFile).then(doc => vscode.window.showTextDocument(doc, column));
                    return;
                }

                fs.readFile(templateFile, 'utf8', (err, data) => {
                    if (err !== null) {
                        vscode.window.showErrorMessage(`can't read template file ${templateFile}`);
                        return;
                    }
                    
                    let cmd = InterfaceBuilder.build(data, paramsMap as ParamsMap);
                    if (cmd === null) {
                        vscode.window.showErrorMessage(`can't parse rule file ${templateFile}`);
                        return;
                    }
               
                    // Remember template file
                    _templateFiles.set(paramsFsPath, templateFile);
    
                    let knownCmdFiles: Thenable<string[]> = new Promise((resolve, reject) => resolve([..._cmdFiles.values()]));
                    let suggestedCmdName = _cmdFiles.get(paramsFsPath);
                    if (suggestedCmdName === undefined) {
                        let paramsPath = path.parse(editor.document.uri.fsPath);
                        let rulesPath = path.parse(templateFile);
                        suggestedCmdName = path.join(paramsPath.dir, `${paramsPath.name}.${rulesPath.name}.txt`);
                    }
    
                    askForFile(suggestedCmdName, knownCmdFiles, 'please pick an output file ...').then((cmdFile) => {
                        if (cmdFile === undefined) {
                            return;
                        }
    
                        fs.writeFile(cmdFile, cmd, 'utf8', (err) => {
                            if (err !== null) {
                                vscode.window.showErrorMessage(`can't write command file ${cmdFile}`);
                                return;
                            }
    
                            return vscode.workspace.openTextDocument(cmdFile).then(doc => {
                                if (doc === undefined) {
                                    vscode.window.showErrorMessage(`something went wrong opening ${cmdFile}`);
                                    return;
                                }
    
                                // Remember cmd file
                                _cmdFiles.set(paramsFsPath, cmdFile);
                                vscode.window.showTextDocument(doc, column);
                            });
                        });
                    });
                });
            });
        });
    });

    function replaceParams(document: vscode.TextDocument, column: vscode.ViewColumn, readOnly: boolean = true) {
        let params = new Params(document);
        let originalUri = document.uri;
        askForFile(getDefaultParamsFile(params), params.discoverParamatersFiles(), 'select a parameter file to use / create ...').then((selected) => {
            if (selected === undefined) {
                return;
            }
            
            if (!params.tryUpdateParams(selected)) {
                vscode.window.showInformationMessage(`Generating parameter value file from ${selected}\n`+
                                                     'Please add any replacement to the value file.');
                params.saveParams(selected).then(p => {
                    setDefaultParamsFile(originalUri, p.fsPath);
                    return vscode.workspace.openTextDocument(p);
                }).then(doc => vscode.window.showTextDocument(doc, column), err => vscode.window.showErrorMessage(err));
            } else {
                params.saveParams(selected).then(p => setDefaultParamsFile(originalUri, p.fsPath), err => vscode.window.showErrorMessage(err));
                const replacementUri = ReplacementProvider.getUri(params);
    
                if (readOnly) {
                    vscode.workspace.openTextDocument(replacementUri)
                        .then(doc => {
                            replacementProvider.update(doc.uri);
                            vscode.window.showTextDocument(doc, column);
                        }, err => vscode.window.showErrorMessage(err));
                } else {
                    vscode.workspace.openTextDocument(replacementUri).then(replaced => {
                        if (replaced === undefined || replaced === null) {
                            vscode.window.showErrorMessage('error replacing document!');
                            return;
                        }
    
                        let outputPath = getDefaultReplacementOutputFile(params, replaced.uri.fsPath);
                        let options: Thenable<string[]|undefined> = new Promise((resolve, reject) => {
                            resolve(outputPath !== replaced.uri.fsPath ? [outputPath, replaced.uri.fsPath] : undefined);
                        });

                        askForFile(outputPath, options, 'save replaced file to ...').then(selected => {
                            if (selected === undefined || selected === null) {
                                return;
                            }
    
                            return fs.writeFile(selected, replaced.getText(), 'utf8', (err) => {
                                if (err !== null) {
                                    vscode.window.showErrorMessage(`Error writing ${selected}: ${err}`);
                                } else {
                                    vscode.window.showTextDocument(vscode.Uri.file(selected));
                                    setDefaultReplacementOutputFile(params, selected);
                                }
                            });}, 
                            err => vscode.window.showErrorMessage(err));
                        });
                }
            }
        });
    }

    context.subscriptions.push(
        providerRegistrations,
        replaceParamsCmd,
        replaceParamsToFileCmd,
        generateScriptFromParamsCmd,
        downloadTemplatesCmd
    );
}

const _paramsFiles = new Map<string, string>();
const _templateFiles = new Map<string, string>();
const _cmdFiles = new Map<string, string>();
const _replacedOutputFiles = new Map<string, string>();

function resolvePath(p: string): string {
    return p.startsWith('~') ? path.join(homedir(), path.normalize(p.replace(/^~[\/\\]/, ''))) : path.normalize(p);
}

function getDefaultTemplateUrl(): string | undefined {
    return vscode.workspace.getConfiguration('frigg', null).get('templatesUrl');
}

function getDefaultTemplatesFolder(resource: vscode.Uri | undefined): string | undefined {
    return vscode.workspace.getConfiguration('frigg', resource).get('templatesFolder');
}

function updateTemplatesFolder(resource: vscode.Uri | undefined, value: any): Thenable<void> {
    const sectionName = 'templatesFolder';
    let config = vscode.workspace.getConfiguration('frigg', resource);
    let inspect = config.inspect(sectionName);
    let useGlobal = inspect === undefined || (inspect.workspaceFolderValue === undefined && inspect.workspaceValue === undefined);
    return config.update(sectionName, value, useGlobal);
}

function getDefaultParamsFile(params: Params): string {
    let d = _paramsFiles.get(params.original.toString());
    return d === undefined ? params.defaultParametersPath() : d;
}

function getDefaultReplacementOutputFile(params: Params, orDefault: string): string {
    let found = _replacedOutputFiles.get(params.original.toString());
    return found !== undefined ? found : orDefault;
}

function setDefaultReplacementOutputFile(params: Params, fsPath: string) {
    _replacedOutputFiles.set(params.original.toString(), fsPath);
}

function getDefaultTemplateFile(paramsFsPath: string): string | undefined {
    return _templateFiles.get(paramsFsPath);
}

function discoverTemplateFiles(resource: vscode.Uri): Thenable<string[]> {
    return new Promise((resolve, reject) => {
        let templates = Array.from(_templateFiles.values());
        let templatesFolder = getDefaultTemplatesFolder(resource);
        if (templatesFolder === undefined) {
            templates.length === 0 ? reject('template folder not set') : resolve(templates);
        } else {
            let folderPath = resolvePath(templatesFolder);
            fs.readdir(folderPath, (err, moreFiles) => {
                if (err === null && moreFiles !== undefined) {
                    let jsonFiles = moreFiles.filter(f => f.endsWith('.json'));
                    templates = templates.concat(jsonFiles.map(f => path.join(folderPath, f)));
                }
                resolve(templates);
            });
        }
    });
}

function nextColumn(editor: vscode.TextEditor): number {
    return editor.viewColumn === undefined ? 1 : Math.min(editor.viewColumn + 1, 2);
}

function setDefaultParamsFile(uri: vscode.Uri, paramsFilePath: string) {
    _paramsFiles.set(uri.toString(), paramsFilePath);
}

function downloadTemplates(resource: vscode.Uri | undefined): Thenable<string[]> {
    return new Promise((resolve, reject) => {
        let url = getDefaultTemplateUrl();
        if (url === undefined) {
            reject('no templates url set!');
            return;
        }

        // Pick template folder
        let templatesFolder = getDefaultTemplatesFolder(resource);
        let opt = {
            defaultUri: templatesFolder !== undefined ? vscode.Uri.file(templatesFolder) : undefined,
            canSelectFiles: false, 
            canSelectMany: false, 
            canSelectFolders: true 
        };

        vscode.window.showOpenDialog(opt).then(selected => {
            if (selected === undefined || selected.length < 1) {
                reject();
                return;
            }

            let selectedFolder = selected[0].fsPath;
            if (!mkFileDirRecursive(selectedFolder)) {
                reject(`can't create folder ${selectedFolder}`);
                return;
            }

            // remember new template folder
            updateTemplatesFolder(resource, selectedFolder);
            
            vscode.window.showQuickPick([url as string], { placeHolder: 'Download templates from ...' }).then(selected => {
                if (selected === undefined) {
                    reject();
                    return;
                }

                makeRequest(selected).then(content => {
                    const items = JSON.parse(content) as any[];
                    let files = items.filter(f => 'type' in f && 'name' in f && 'download_url' in f && f['type'] === 'file');
                    if (files.length === 0) {
                        reject('no template files found.');
                        return;
                    }
                    
                    let completed: string[] = [];
                    let errors = 0;
                    let complete = function() {
                        if (completed.length + errors >= files.length) {
                            vscode.window.showInformationMessage(`Done! ${files.length - errors} templates downloaded, ${errors} errors.`);
                            resolve(completed);
                        }
                    };

                    for (let i = 0; i < files.length; ++i) {
                        let f = files[i];
                        let filePath = path.join(selectedFolder, f['name']);
                        vscode.window.showInformationMessage(`downloading ${f['name']} ...`);
                        makeRequest(f['download_url']).then(body => {
                            if (body === undefined || body === null) {
                                vscode.window.showErrorMessage(`can't download ${f['name']} from: ${f['download_url']}`);
                                errors++;
                                complete();
                                return;
                            }

                            fs.writeFile(filePath, body, 'utf8', err => {
                                if (err !== null) {
                                    vscode.window.showErrorMessage(`can't write template file ${filePath}: ${err}`);
                                    complete();
                                    return;
                                }

                                completed.push(filePath);
                                complete();
                            });
                        });
                    }
                });
            }); 
        });
    });
}

function quickPickFile(f: string): vscode.QuickPickItem {
    let p = path.parse(f as string);
    return {
        label: p.base,
        detail: f,
    } as vscode.QuickPickItem;
}

function askForFile(defaultFile: string | undefined,
                    files: Thenable<string[] | undefined> | null,
                    placeHolder: string,
                    overWritePick: boolean = true): Thenable<string|undefined> {
    
    let qpo: vscode.QuickPickOptions = {
        placeHolder: placeHolder,
        matchOnDescription: true,
    };
    
    let shouldOpenDialog = { label: 'pick a file ...' } as vscode.QuickPickItem;

    let options: Thenable<vscode.QuickPickItem[]> | vscode.QuickPickItem[];
    if (files === null) {
        options = (defaultFile === undefined ? [shouldOpenDialog] : [quickPickFile(defaultFile), shouldOpenDialog]);
    } else {
        options = files.then((files) => {
            let opts = (files === undefined ? [] : files).filter(f => f !== defaultFile).map(f => quickPickFile(f)).concat([shouldOpenDialog]);
            return defaultFile === undefined ? opts : [quickPickFile(defaultFile)].concat(opts);
        });
    }

    return vscode.window.showQuickPick(options, qpo).then(selected => {
        if (selected && selected !== undefined) {
            if (selected === shouldOpenDialog) {
                let dialogOptions = { 
                    defaultUri: defaultFile !== undefined ? vscode.Uri.file(defaultFile) : undefined,
                    canSelectFiles: false,
                    canSelectFolders: false,
                    canSelectMany: false
                };

                if (overWritePick) {
                    return vscode.window.showSaveDialog(dialogOptions).then(selectedUri => {
                        if (selectedUri !== undefined) {
                            return selectedUri.fsPath;
                        }
                    });
                } else {
                    return vscode.window.showOpenDialog(dialogOptions).then(selectedUris => {
                        if (selectedUris !== undefined && selectedUris.length === 1) {
                            return selectedUris[0].fsPath;
                        }
                    });
                }
            } else {
                return new Promise((resolve, reject) => resolve(selected.detail as string));
            }
        }
        return new Promise((resolve, reject) => reject());
    });
}

function makeRequest(url: string): Thenable<string> {
    return new Promise((resolve, reject) => {
        let ro = {
            url: url,
            headers: {
                'User-Agent': 'vscode-frigg'
            }
        };

        request(ro, (error: any | null, response: any|null, body: any|null) => {
            if (error !== null) {
                vscode.window.showErrorMessage(`error fetching "${ro.url}": ${error}`);
                reject(error);
            } else if (response === null || response.statusCode !== 200) {
                vscode.window.showErrorMessage(`wrong response for "${ro.url}": ${response.statusCode}\n${JSON.stringify(response)}`);
                reject(response);
            } else {
                resolve(body);
            }
        });
    });
}

// this method is called when your extension is deactivated
export function deactivate() {
    _paramsFiles.clear();
    _templateFiles.clear();
    _cmdFiles.clear();
    _replacedOutputFiles.clear();
}

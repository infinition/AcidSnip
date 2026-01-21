import * as vscode from 'vscode';
import * as https from 'https';

interface TreeItemData {
    id: string;
    name: string;
    command?: string;
    description?: string;
    type: 'snippet' | 'separator' | 'tab' | 'folder';
    color?: string;
    parentId?: string;
    expanded?: boolean;
}

interface Settings {
    showReloadButton: boolean;
    configFilePath: string;
    confirmDelete: boolean;
    showVersionChecker: boolean;
    githubUsername?: string;
    showGithubButton: boolean;
    executionMode: 'terminal' | 'editor' | 'locked';
    enableRichTooltips: boolean;
    commandHistoryLimit: number;
    clipboardHistoryLimit: number;
}

export function activate(context: vscode.ExtensionContext) {
    console.log('AcidSnip is now active!');

    const provider = new SnippetViewProvider(context.extensionUri, context);

    context.subscriptions.push(
        vscode.window.registerWebviewViewProvider('fastSnippetExplorer', provider)
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('fastSnippetTerminal.addSnippet', () => {
            provider.sendMessage({ type: 'triggerAddSnippet' });
        }),
        vscode.commands.registerCommand('fastSnippetTerminal.addTab', () => {
            provider.sendMessage({ type: 'triggerAddTab' });
        }),
        vscode.commands.registerCommand('fastSnippetTerminal.cdHere', (uri: vscode.Uri) => {
            provider.cdToUri(uri);
        }),
        vscode.commands.registerCommand('fastSnippetTerminal.showHistory', () => {
            provider.sendMessage({ type: 'openHistory' });
        })
    );
}

class SnippetViewProvider implements vscode.WebviewViewProvider {
    public static readonly viewType = 'fastSnippetExplorer';
    private _view?: vscode.WebviewView;

    constructor(
        private readonly _extensionUri: vscode.Uri,
        private readonly _context: vscode.ExtensionContext
    ) {
        this._startClipboardWatcher();
    }

    private _lastClipboardText: string = '';
    private _startClipboardWatcher() {
        setInterval(async () => {
            try {
                const text = await vscode.env.clipboard.readText();
                if (text && text !== this._lastClipboardText) {
                    this._lastClipboardText = text;
                    this._addToClipboardHistory(text);
                }
            } catch (e) {
                // Ignore errors
            }
        }, 1000);
    }

    private async _addToClipboardHistory(text: string) {
        const settings = await this.getStoredSettings();
        let history: string[] = this._context.globalState.get('clipboardHistory', []);
        history = history.filter(h => h !== text);
        history.unshift(text);
        if (history.length > settings.clipboardHistoryLimit) {
            history = history.slice(0, settings.clipboardHistoryLimit);
        }
        await this._context.globalState.update('clipboardHistory', history);
        this._view?.webview.postMessage({ type: 'loadHistory', clipboardHistory: history });
    }

    private async _addToCommandHistory(command: string) {
        const settings = await this.getStoredSettings();
        let history: string[] = this._context.globalState.get('commandHistory', []);
        history = history.filter(h => h !== command);
        history.unshift(command);
        if (history.length > settings.commandHistoryLimit) {
            history = history.slice(0, settings.commandHistoryLimit);
        }
        await this._context.globalState.update('commandHistory', history);
        this._view?.webview.postMessage({ type: 'loadHistory', commandHistory: history });
    }

    public resolveWebviewView(
        webviewView: vscode.WebviewView,
        context: vscode.WebviewViewResolveContext,
        _token: vscode.CancellationToken,
    ) {
        this._view = webviewView;

        webviewView.webview.options = {
            enableScripts: true,
            localResourceRoots: [this._extensionUri]
        };

        webviewView.webview.html = this._getHtmlForWebview(webviewView.webview);

        webviewView.webview.onDidReceiveMessage(async (data) => {
            switch (data.type) {
                case 'ready':
                    this.sendItems();
                    this.sendSettings();
                    this.sendHistory();
                    break;
                case 'saveItems':
                    await this.saveItems(data.items);
                    break;
                case 'executeCommand':
                    this.executeCommand(data.command);
                    break;
                case 'showInfo':
                    vscode.window.showInformationMessage(data.message);
                    break;
                case 'askInput':
                    const input = await vscode.window.showInputBox({ prompt: data.prompt, value: data.value });
                    if (input !== undefined) {
                        this.sendMessage({ type: 'inputResponse', requestId: data.requestId, value: input });
                    }
                    break;
                case 'cdToActiveFile':
                    this.cdToUri();
                    break;
                case 'reloadExtensions':
                    await vscode.commands.executeCommand('workbench.action.reloadWindow');
                    break;
                case 'exportConfig':
                    const exportUri = await vscode.window.showSaveDialog({
                        defaultUri: vscode.Uri.file('acidsnip-config.json'),
                        filters: { 'JSON': ['json'] }
                    });
                    if (exportUri) {
                        const items = await this.getStoredItems();
                        const settings = await this.getStoredSettings();
                        const configData = { items, settings };
                        await vscode.workspace.fs.writeFile(exportUri, Buffer.from(JSON.stringify(configData, null, 2)));
                        vscode.window.showInformationMessage('Configuration exported successfully!');
                    }
                    break;
                case 'importConfig':
                    const importUri = await vscode.window.showOpenDialog({
                        canSelectMany: false,
                        filters: { 'JSON': ['json'] }
                    });
                    if (importUri && importUri[0]) {
                        try {
                            const content = await vscode.workspace.fs.readFile(importUri[0]);
                            const configData = JSON.parse(Buffer.from(content).toString('utf8'));
                            const defaultSettings: Settings = {
                                showReloadButton: false,
                                configFilePath: '',
                                confirmDelete: false,
                                showVersionChecker: false,
                                githubUsername: '',
                                showGithubButton: true,
                                executionMode: 'terminal',
                                enableRichTooltips: true,
                                commandHistoryLimit: 20,
                                clipboardHistoryLimit: 20
                            };
                            const items = configData.items || [];
                            const settings = { ...defaultSettings, ...configData.settings };
                            await this.writeConfigToFile(items, settings);
                            await this.sendItems();
                            await this.sendSettings();
                            vscode.window.showInformationMessage('Configuration imported successfully!');
                        } catch (e) {
                            vscode.window.showErrorMessage('Failed to import configuration: Invalid file format');
                        }
                    }
                    break;
                case 'selectConfigPath':
                    const configUri = await vscode.window.showSaveDialog({
                        defaultUri: vscode.Uri.file('acidsnip-config.json'),
                        filters: { 'JSON': ['json'] }
                    });
                    if (configUri) {
                        // Get current data before switching
                        const currentItems = await this.getStoredItems();
                        const currentSettings = await this.getStoredSettings();

                        // Store the new path in globalState
                        await this._context.globalState.update('configFilePath', configUri.fsPath);

                        // Write current data to new file
                        await this.writeConfigToFile(currentItems, currentSettings);

                        await this.sendSettings();
                        vscode.window.showInformationMessage('Config file set: ' + configUri.fsPath);
                    }
                    break;
                case 'saveSettings':
                    await this.saveSettings(data.settings);
                    await this.sendSettings();
                    break;
                case 'getSettings':
                    await this.sendSettings();
                    break;
                case 'fetchGithubRepos':
                    this.fetchGithubRepos(data.username);
                    break;
                case 'cloneRepo':
                    this.cloneRepo(data.cloneUrl, data.name);
                    break;
                case 'ready':
                    await this.sendItems();
                    await this.sendSettings();
                    break;
                case 'checkVersion':
                    const versionInfo = await this.getVersionInfo();
                    this.sendMessage({ type: 'versionInfo', ...versionInfo });
                    break;
            }
        });

        // Resend items when the view becomes visible again
        webviewView.onDidChangeVisibility(async () => {
            if (webviewView.visible) {
                await this.sendItems();
                await this.sendSettings();
            }
        });
    }

    // Get the config file path from globalState
    private getConfigFilePath(): string {
        return this._context.globalState.get<string>('configFilePath', '');
    }

    // Read config from external file
    private async readConfigFromFile(): Promise<{ items: TreeItemData[], settings: Partial<Settings> }> {
        const filePath = this.getConfigFilePath();
        if (!filePath) {
            // Fallback to globalState if no file configured
            return {
                items: this._context.globalState.get<TreeItemData[]>('snippets', []),
                settings: this._context.globalState.get<Partial<Settings>>('settings', {})
            };
        }

        try {
            const uri = vscode.Uri.file(filePath);
            const content = await vscode.workspace.fs.readFile(uri);
            const data = JSON.parse(Buffer.from(content).toString('utf8'));
            return {
                items: data.items || [],
                settings: data.settings || {}
            };
        } catch (e) {
            // File doesn't exist or is invalid, fallback to globalState
            return {
                items: this._context.globalState.get<TreeItemData[]>('snippets', []),
                settings: this._context.globalState.get<Partial<Settings>>('settings', {})
            };
        }
    }

    // Write config to external file
    private async writeConfigToFile(items: TreeItemData[], settings: Partial<Settings>): Promise<void> {
        const filePath = this.getConfigFilePath();
        if (!filePath) {
            // Fallback to globalState if no file configured
            await this._context.globalState.update('snippets', items);
            await this._context.globalState.update('settings', settings);
            return;
        }

        try {
            const uri = vscode.Uri.file(filePath);
            const configData = { items, settings };
            await vscode.workspace.fs.writeFile(uri, Buffer.from(JSON.stringify(configData, null, 2)));
        } catch (e) {
            vscode.window.showErrorMessage('Failed to save config: ' + (e as Error).message);
            // Still save to globalState as backup
            await this._context.globalState.update('snippets', items);
            await this._context.globalState.update('settings', settings);
        }
    }

    private async saveItems(items: TreeItemData[]) {
        const config = await this.readConfigFromFile();
        await this.writeConfigToFile(items, config.settings);
    }

    private async getStoredItems(): Promise<TreeItemData[]> {
        const config = await this.readConfigFromFile();
        return config.items;
    }

    private async sendItems() {
        if (this._view) {
            const items = await this.getStoredItems();
            this._view.webview.postMessage({ type: 'loadItems', items });
        }
    }

    public sendMessage(data: any) {
        if (this._view) {
            this._view.webview.postMessage(data);
        }
    }

    private async getStoredSettings(): Promise<Settings> {
        const defaultSettings: Settings = {
            showReloadButton: false,
            configFilePath: '',
            confirmDelete: false,
            showVersionChecker: false,
            githubUsername: '',
            showGithubButton: true,
            executionMode: 'terminal',
            enableRichTooltips: true,
            commandHistoryLimit: 20,
            clipboardHistoryLimit: 20
        };
        const config = await this.readConfigFromFile();
        // Get configFilePath from globalState (not from file)
        const configFilePath = this.getConfigFilePath();
        return { ...defaultSettings, ...config.settings, configFilePath };
    }

    private async saveSettings(settings: Settings) {
        const config = await this.readConfigFromFile();
        await this.writeConfigToFile(config.items, settings);
    }

    private async sendSettings() {
        if (this._view) {
            const settings = await this.getStoredSettings();
            this._view.webview.postMessage({ type: 'loadSettings', settings });
        }
    }

    private sendHistory() {
        const commandHistory = this._context.globalState.get('commandHistory', []);
        const clipboardHistory = this._context.globalState.get('clipboardHistory', []);
        this._view?.webview.postMessage({ type: 'loadHistory', commandHistory, clipboardHistory });
    }

    private async getVersionInfo(): Promise<{ localVersion: string | null, remoteVersion: string | null, repoUrl: string | null, projectName: string | null, error: string | null }> {
        const targetPath = await this.getTargetPath();
        if (!targetPath) {
            return { localVersion: null, remoteVersion: null, repoUrl: null, projectName: null, error: 'No folder or file selected' };
        }

        // Determine the directory to look in
        let rootPath = targetPath;
        try {
            const stats = await vscode.workspace.fs.stat(vscode.Uri.file(targetPath));
            if ((stats.type & vscode.FileType.Directory) === 0) {
                const path = require('path');
                rootPath = path.dirname(targetPath);
            }
        } catch (e) {
            // ignore
        }
        let localVersion: string | null = null;
        let repoUrl: string | null = null;
        let projectName: string | null = null;

        // Version file patterns to check (in priority order)
        const versionFiles = [
            { file: 'package.json', versionKey: 'version', repoKey: 'repository', nameKey: 'name' },
            { file: 'manifest.json', versionKey: 'version', nameKey: 'name' },
            { file: 'Cargo.toml', pattern: /^version\s*=\s*"([^"]+)"/m, namePattern: /^name\s*=\s*"([^"]+)"/m },
            { file: 'pyproject.toml', pattern: /^version\s*=\s*"([^"]+)"/m, namePattern: /^name\s*=\s*"([^"]+)"/m },
            { file: 'setup.py', pattern: /version\s*=\s*['"]([^'"]+)['"]/, namePattern: /name\s*=\s*['"]([^'"]+)['"]/ },
            { file: 'version.txt', raw: true },
            { file: 'VERSION', raw: true }
        ];

        // Try to find local version
        for (const vf of versionFiles) {
            try {
                const filePath = vscode.Uri.file(rootPath + '/' + vf.file);
                const content = await vscode.workspace.fs.readFile(filePath);
                const text = Buffer.from(content).toString('utf8');

                if (vf.raw) {
                    localVersion = text.trim().split('\\n')[0].trim();
                    break;
                }

                if (vf.versionKey) {
                    const json = JSON.parse(text);
                    localVersion = json[vf.versionKey] || null;
                    projectName = json[vf.nameKey] || projectName;

                    // Extract repo URL from package.json
                    if (vf.repoKey && json[vf.repoKey]) {
                        const repo = json[vf.repoKey];
                        if (typeof repo === 'string') {
                            repoUrl = repo;
                        } else if (repo.url) {
                            repoUrl = repo.url;
                        }
                    }
                    if (localVersion) break;
                }

                if (vf.pattern) {
                    const match = text.match(vf.pattern);
                    if (match) localVersion = match[1];
                    if (vf.namePattern) {
                        const nameMatch = text.match(vf.namePattern);
                        if (nameMatch) projectName = nameMatch[1];
                    }
                    if (localVersion) break;
                }
            } catch (e) {
                // File not found, continue
            }
        }

        // Try to get repo URL from .git/config
        if (!repoUrl) {
            try {
                const gitConfigPath = vscode.Uri.file(rootPath + '/.git/config');
                const gitConfig = await vscode.workspace.fs.readFile(gitConfigPath);
                const gitText = Buffer.from(gitConfig).toString('utf8');
                const urlMatch = gitText.match(/url\s*=\s*(.+github\.com[:/]([^/]+)\/([^/\s.]+))/i);
                if (urlMatch) {
                    const owner = urlMatch[2];
                    const repo = urlMatch[3].replace(/\.git$/, '');
                    repoUrl = 'https://github.com/' + owner + '/' + repo;
                }
            } catch (e) {
                // No .git/config
            }
        }

        // Clean up repo URL
        if (repoUrl) {
            repoUrl = repoUrl.replace(/^git\+/, '').replace(/\.git$/, '');
            if (repoUrl.includes('git@github.com:')) {
                repoUrl = repoUrl.replace('git@github.com:', 'https://github.com/');
            }
        }

        // Helper function to make HTTPS requests
        const httpGet = (url: string): Promise<string | null> => {
            return new Promise((resolve) => {
                const req = https.get(url, { headers: { 'User-Agent': 'AcidSnip-VSCode' } }, (res) => {
                    // Handle redirects
                    if (res.statusCode === 301 || res.statusCode === 302) {
                        if (res.headers.location) {
                            httpGet(res.headers.location).then(resolve);
                            return;
                        }
                    }
                    if (res.statusCode !== 200) {
                        resolve(null);
                        return;
                    }
                    let data = '';
                    res.on('data', chunk => data += chunk);
                    res.on('end', () => resolve(data));
                });
                req.on('error', () => resolve(null));
                req.setTimeout(5000, () => { req.destroy(); resolve(null); });
            });
        };

        // Try to get remote version from GitHub
        let remoteVersion: string | null = null;
        if (repoUrl && repoUrl.includes('github.com')) {
            const match = repoUrl.match(/github\.com\/([^/]+)\/([^/]+)/);
            if (match) {
                const owner = match[1];
                const repo = match[2];

                // Try GitHub releases API first
                try {
                    const data = await httpGet('https://api.github.com/repos/' + owner + '/' + repo + '/releases/latest');
                    if (data) {
                        const release = JSON.parse(data) as { tag_name: string };
                        remoteVersion = release.tag_name?.replace(/^v/, '') || null;
                    }
                } catch (e) {
                    // Releases failed
                }

                // Fallback: try to get package.json from repo
                if (!remoteVersion) {
                    try {
                        const data = await httpGet('https://raw.githubusercontent.com/' + owner + '/' + repo + '/main/package.json');
                        if (data) {
                            const pkg = JSON.parse(data) as { version: string };
                            remoteVersion = pkg.version || null;
                        }
                    } catch (e) {
                        // Fallback failed
                    }
                }

                // Fallback: try master branch
                if (!remoteVersion) {
                    try {
                        const data = await httpGet('https://raw.githubusercontent.com/' + owner + '/' + repo + '/master/package.json');
                        if (data) {
                            const pkg = JSON.parse(data) as { version: string };
                            remoteVersion = pkg.version || null;
                        }
                    } catch (e) {
                        // Fallback failed
                    }
                }
            }
        }

        const path = require('path');
        return {
            localVersion,
            remoteVersion,
            repoUrl,
            projectName: projectName || path.basename(rootPath) || 'Unknown Project',
            error: null
        };
    }

    private async executeCommand(cmd: string) {
        let finalCmd = cmd;
        const argRegex = /\{\{arg\$(\d+):([^}]+)\}\}/g;
        const matches = Array.from(cmd.matchAll(argRegex));

        if (matches.length > 0) {
            const argsMap = new Map<string, { label: string, value?: string }>();
            matches.forEach(match => {
                const id = match[1];
                const label = match[2];
                if (!argsMap.has(id)) {
                    argsMap.set(id, { label });
                }
            });

            const sortedIds = Array.from(argsMap.keys()).sort((a, b) => parseInt(a) - parseInt(b));

            for (const id of sortedIds) {
                const arg = argsMap.get(id)!;
                const input = await vscode.window.showInputBox({
                    prompt: `Enter value for: ${arg.label}`,
                    placeHolder: arg.label,
                    ignoreFocusOut: true
                });
                if (input === undefined) return;
                arg.value = input;
            }

            finalCmd = cmd.replace(argRegex, (match, id) => {
                return argsMap.get(id)?.value || match;
            });
        }

        const settings = await this.getStoredSettings();
        this._addToCommandHistory(finalCmd);

        if (settings.executionMode === 'editor') {
            const editor = vscode.window.activeTextEditor;
            if (editor) {
                editor.edit(editBuilder => {
                    editBuilder.insert(editor.selection.active, finalCmd);
                });
            } else {
                vscode.window.showWarningMessage('No active text editor to insert snippet.');
            }
        } else {
            const terminal = vscode.window.activeTerminal || vscode.window.createTerminal('AcidSnip');
            terminal.show();
            terminal.sendText(finalCmd);
        }
    }

    public async cdToUri(uri?: vscode.Uri) {
        const targetPath = await this.getTargetPath(uri);

        if (targetPath) {
            try {
                const stats = await vscode.workspace.fs.stat(vscode.Uri.file(targetPath));
                const isDirectory = (stats.type & vscode.FileType.Directory) !== 0;
                const path = require('path');
                const dirPath = isDirectory ? targetPath : path.dirname(targetPath);
                const dirName = path.basename(dirPath) || 'AcidSnip';

                let terminal = vscode.window.terminals.find(t => t.name === dirName);
                if (!terminal) {
                    terminal = vscode.window.createTerminal(dirName);
                }
                terminal.show();

                const isWindows = process.platform === 'win32';
                const cdCmd = isWindows ? `cd /d "${dirPath}"` : `cd "${dirPath}"`;
                const clearCmd = isWindows ? 'cls' : 'clear';

                terminal.sendText(`${cdCmd} && ${clearCmd}`);
            } catch (e) {
                vscode.window.showErrorMessage('Could not determine directory path.');
            }
        } else {
            vscode.window.showWarningMessage('No file or folder selected.');
        }
    }

    private async getTargetPath(uri?: vscode.Uri): Promise<string | undefined> {
        let targetPath: string | undefined;

        if (uri) {
            targetPath = uri.fsPath;
        } else {
            const oldClipboard = await vscode.env.clipboard.readText();
            try {
                await vscode.commands.executeCommand('workbench.files.action.focusFilesExplorer');
                await vscode.commands.executeCommand('copyFilePath');
                const explorerPath = await vscode.env.clipboard.readText();
                if (explorerPath && explorerPath !== oldClipboard) {
                    targetPath = explorerPath;
                }
            } catch (e) {
                // ignore
            } finally {
                await vscode.env.clipboard.writeText(oldClipboard);
            }

            if (!targetPath) {
                const editor = vscode.window.activeTextEditor;
                if (editor) {
                    targetPath = editor.document.uri.fsPath;
                }
            }
        }

        if (!targetPath && vscode.workspace.workspaceFolders?.length) {
            targetPath = vscode.workspace.workspaceFolders[0].uri.fsPath;
        }

        return targetPath;
    }

    private async fetchGithubRepos(username: string) {
        const options = {
            hostname: 'api.github.com',
            path: `/users/${username}/repos?sort=created&direction=desc`,
            headers: {
                'User-Agent': 'AcidSnip-VSCode-Extension'
            }
        };

        https.get(options, (res) => {
            let data = '';
            res.on('data', (chunk) => data += chunk);
            res.on('end', () => {
                try {
                    const repos = JSON.parse(data);
                    if (Array.isArray(repos)) {
                        this.sendMessage({
                            type: 'githubReposResponse', repos: repos.map((r: any) => ({
                                name: r.name,
                                description: r.description,
                                cloneUrl: r.clone_url,
                                stars: r.stargazers_count,
                                language: r.language,
                                updatedAt: r.updated_at
                            }))
                        });
                    } else {
                        this.sendMessage({ type: 'githubReposError', message: repos.message || 'User not found' });
                    }
                } catch (e) {
                    this.sendMessage({ type: 'githubReposError', message: 'Failed to parse GitHub response' });
                }
            });
        }).on('error', (e) => {
            this.sendMessage({ type: 'githubReposError', message: e.message });
        });
    }

    private async cloneRepo(cloneUrl: string, name: string) {
        const targetPath = await this.getTargetPath();
        if (!targetPath) {
            vscode.window.showWarningMessage('Please select a folder in the explorer first.');
            return;
        }

        try {
            const stats = await vscode.workspace.fs.stat(vscode.Uri.file(targetPath));
            const isDirectory = (stats.type & vscode.FileType.Directory) !== 0;
            const path = require('path');
            const dirPath = isDirectory ? targetPath : path.dirname(targetPath);
            const dirName = path.basename(dirPath) || 'AcidSnip';

            let terminal = vscode.window.terminals.find(t => t.name === dirName);
            if (!terminal) {
                terminal = vscode.window.createTerminal(dirName);
            }
            terminal.show();

            const isWindows = process.platform === 'win32';
            const cdCmd = isWindows ? `cd /d "${dirPath}"` : `cd "${dirPath}"`;
            const cloneCmd = `git clone ${cloneUrl}`;

            terminal.sendText(`${cdCmd} && ${cloneCmd}`);
            vscode.window.showInformationMessage(`Cloning ${name} into ${dirPath}...`);
        } catch (e) {
            vscode.window.showErrorMessage('Could not determine directory path.');
        }
    }

    private _getHtmlForWebview(webview: vscode.Webview) {
        return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <link href="https://cdn.jsdelivr.net/npm/@vscode/codicons/dist/codicon.css" rel="stylesheet" />
    <title>AcidSnip</title>
    <style>
        body {
            font-family: var(--vscode-font-family);
            color: var(--vscode-foreground);
            background-color: var(--vscode-editor-background);
            padding: 0; margin: 0; display: flex; flex-direction: row; height: 100vh; overflow: hidden;
        }
        .execution-toggle-btn {
            padding: 5px 10px; cursor: pointer; opacity: 0.7; font-size: 14px;
            user-select: none; display: flex; align-items: center; justify-content: center;
            border-bottom: 2px solid transparent; flex-shrink: 0;
        }
        .execution-toggle-btn:hover { opacity: 1; background-color: var(--vscode-list-hoverBackground); }
        
        .settings-btn {
            padding: 5px 10px; cursor: pointer; opacity: 0.7; font-size: 14px;
            user-select: none; display: flex; align-items: center; justify-content: center;
            border-bottom: 2px solid transparent; flex-shrink: 0; margin-left: auto;
        }
        .settings-btn:hover { opacity: 1; background-color: var(--vscode-list-hoverBackground); }

        .drop-indicator {
            position: absolute;
            left: 0;
            right: 0;
            height: 2px;
            background-color: var(--vscode-focusBorder);
            z-index: 100;
            pointer-events: none;
            display: none;
        }
        .drop-indicator.vertical {
            width: 2px;
            height: 100%;
            top: 0;
            bottom: 0;
            left: auto;
            right: auto;
        }
        
        .tabs-container {
            display: flex; overflow-x: auto; overflow-y: hidden;
            background-color: var(--vscode-sideBarSectionHeader-background);
            border-bottom: 1px solid var(--vscode-sideBarSectionHeader-border);
            padding: 0 5px; align-items: center; height: 38px; flex-shrink: 0; white-space: nowrap;
        }
        .tabs-container::-webkit-scrollbar { height: 3px; }
        .tabs-container::-webkit-scrollbar-thumb { background: var(--vscode-scrollbarSlider-background); border-radius: 3px; }
        .tabs-container::-webkit-scrollbar-thumb:hover { background: var(--vscode-scrollbarSlider-hoverBackground); }
        .tab {
            padding: 5px 10px; cursor: pointer; opacity: 0.7; border-bottom: 2px solid transparent; font-size: 12px;
            user-select: none; display: flex; align-items: center; gap: 5px; flex-shrink: 0;
        }
        .tab:hover { opacity: 1; background-color: var(--vscode-list-hoverBackground); }
        .tab.active { opacity: 1; border-bottom-color: var(--vscode-activityBarBadge-background); font-weight: bold; }
        .main-container { flex: 1; display: flex; flex-direction: column; min-width: 0; height: 100vh; position: relative; }
        .content { flex: 1; overflow-y: auto; padding: 10px; }
        
        /* Sidebar & FAB Integration */
        .sidebar {
            width: 44px; background-color: var(--vscode-sideBar-background);
            display: flex; flex-direction: column; align-items: center; justify-content: center; padding: 10px 0; gap: 12px; flex-shrink: 0;
            transition: all 0.2s ease;
            position: relative;
        }
        .sidebar-left { border-right: 1px solid var(--vscode-sideBar-border); cursor: pointer; }
        .sidebar-left:hover { background-color: rgba(255, 255, 255, 0.03); }
        .sidebar-right { border-left: 1px solid var(--vscode-sideBar-border); }
        .sidebar-right.horizontal {
            width: 100%;
            height: 44px;
            flex-direction: row;
            border-left: none;
            border-top: 1px solid var(--vscode-sideBar-border);
            padding: 0 10px;
            gap: 12px;
            justify-content: center;
        }

        .side-add-container {
            position: relative;
            display: flex;
            flex-direction: column;
            align-items: center;
        }
        .side-add-btn {
            width: 32px; height: 32px; display: flex; justify-content: center; align-items: center;
            cursor: pointer; border-radius: 50%; font-size: 20px;
            background-color: var(--vscode-button-background);
            color: var(--vscode-button-foreground);
            border: none;
            transition: all 0.2s;
        }
        .side-add-btn:hover {
            background-color: var(--vscode-button-hoverBackground);
            transform: scale(1.1) rotate(90deg);
        }
        .side-add-menu {
            position: absolute;
            left: 38px; /* Reduced to eliminate gap */
            top: 0;
            display: flex;
            flex-direction: column;
            gap: 8px;
            opacity: 0;
            pointer-events: none;
            transform: translateX(-5px);
            transition: all 0.2s ease;
            z-index: 1100;
            background-color: var(--vscode-editorWidget-background);
            padding: 8px;
            border-radius: 8px;
            border: 1px solid var(--vscode-widget-border);
            box-shadow: 0 4px 12px rgba(0,0,0,0.4);
        }
        /* Bridge to stabilize hover */
        .side-add-menu::before {
            content: '';
            position: absolute;
            left: -15px;
            top: 0;
            width: 15px;
            height: 100%;
            background: transparent;
        }
        .side-add-menu.horizontal {
            flex-direction: row;
            left: 45px;
            top: 0;
            transform: translateX(-5px);
        }
        .side-add-menu.horizontal .side-add-item::after {
            top: 40px;
            left: 50%;
            transform: translateX(-50%);
            right: auto;
        }
        .side-add-menu.horizontal .side-add-item:hover::after {
            opacity: 1;
            transform: translateX(-50%) translateY(5px);
        }
        .side-add-container:hover .side-add-menu {
            opacity: 1;
            pointer-events: auto;
            transform: translateX(0);
        }
        .side-add-item {
            width: 32px; height: 32px; display: flex; justify-content: center; align-items: center;
            cursor: pointer; border-radius: 6px; font-size: 16px;
            transition: all 0.2s;
            color: var(--vscode-foreground);
        }
        .side-add-item:hover {
            background-color: var(--vscode-list-hoverBackground);
            transform: scale(1.1);
        }
        .side-add-item::after {
            content: attr(data-label);
            position: absolute;
            left: 40px;
            background-color: var(--vscode-editorWidget-background);
            color: var(--vscode-foreground);
            padding: 4px 8px;
            border-radius: 4px;
            font-size: 11px;
            white-space: nowrap;
            opacity: 0;
            pointer-events: none;
            transition: opacity 0.2s;
            border: 1px solid var(--vscode-widget-border);
        }
        .side-add-item:hover::after {
            opacity: 1;
        }

        .side-btn {
            width: 32px; height: 32px; display: flex; justify-content: center; align-items: center;
            cursor: pointer; border-radius: 6px; font-size: 18px; opacity: 0.8;
            transition: all 0.2s; background: none; border: none; color: var(--vscode-foreground);
            position: relative; flex-shrink: 0;
        }
        .side-btn:hover { opacity: 1; background-color: var(--vscode-list-hoverBackground); transform: scale(1.1); }
        .side-btn.primary { background-color: var(--vscode-button-background); color: var(--vscode-button-foreground); opacity: 1; }
        .side-btn.primary:hover { background-color: var(--vscode-button-hoverBackground); }
        .side-spacer { flex: 1; }
        
        /* Horizontal toolbar mode when viewport is too short */
        body.horizontal-toolbar { flex-direction: column; }
        body.horizontal-toolbar .main-container { flex: 1; height: auto; min-height: 0; }
        body.horizontal-toolbar .sidebar {
            width: 100%; height: 44px; flex-direction: row; justify-content: center;
            border-left: none; border-top: 1px solid var(--vscode-sideBar-border);
            padding: 0 10px; gap: 8px; order: 1;
        }
        body.horizontal-toolbar .side-spacer { display: none; }
        body.horizontal-toolbar .side-btn { width: 28px; height: 28px; font-size: 16px; }
        .snippet-item {
            display: flex; align-items: center; padding: 6px 8px; margin-bottom: 4px; border-radius: 4px;
            background-color: var(--vscode-list-inactiveSelectionBackground); cursor: pointer; position: relative;
            border-left: 3px solid transparent; user-select: none; gap: 8px;
        }
        .snippet-item:hover { background-color: var(--vscode-list-hoverBackground); }
        .drag-handle { cursor: grab; opacity: 0.4; font-size: 14px; padding: 0 4px; display: flex; align-items: center; }
        .drag-handle:hover { opacity: 1; }
        .dragging .drag-handle { cursor: grabbing; }
        .locked-mode .snippet-item, .locked-mode .folder-header { cursor: grab; }
        .locked-mode .snippet-item:active, .locked-mode .folder-header:active { cursor: grabbing; }
        .locked-mode .drag-handle { display: none; }
        .snippet-item.locked { opacity: 0.8; }
        
        .inline-edit-input {
            background: transparent;
            border: none;
            border-bottom: 1px solid var(--vscode-focusBorder);
            color: var(--vscode-foreground);
            font-family: inherit;
            font-size: inherit;
            width: 100%;
            padding: 0;
            margin: 0;
            outline: none;
        }
        .snippet-item.separator {
            height: 24px; margin: 4px 0; padding: 0 8px; cursor: default; border-left: none; flex-shrink: 0; position: relative;
            display: flex; align-items: center; background: transparent; gap: 8px;
        }
        .snippet-item.separator:hover { background-color: var(--vscode-list-hoverBackground); }
        .folder-item { margin-bottom: 4px; border-radius: 4px; overflow: hidden; }
        .folder-header {
            display: flex; align-items: center; padding: 6px 8px; background-color: var(--vscode-list-inactiveSelectionBackground);
            cursor: pointer; user-select: none; gap: 8px; border-left: 3px solid transparent;
        }
        .folder-header:hover { background-color: var(--vscode-list-hoverBackground); }
        .folder-content { padding-left: 15px; display: none; border-left: 1px solid var(--vscode-widget-border); margin-left: 15px; }
        .folder-item.expanded > .folder-content { display: block; }
        .folder-toggle { font-size: 10px; transition: transform 0.2s; width: 12px; text-align: center; }
        .folder-item.expanded > .folder-header .folder-toggle { transform: rotate(90deg); }
        .snippet-name { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-weight: 500; }
        .snippet-command { font-size: 0.8em; opacity: 0.7; margin-left: 10px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 40%; font-family: monospace; text-align: right; }
        .smart-badge { font-size: 10px; background: var(--vscode-badge-background); color: var(--vscode-badge-foreground); padding: 1px 4px; border-radius: 3px; margin-left: 6px; opacity: 0.8; }
        .actions { display: none; gap: 5px; margin-left: 10px; }
        .snippet-item:hover .actions, .folder-header:hover .actions { display: flex; }
        .action-btn { background: none; border: none; color: inherit; cursor: pointer; opacity: 0.7; padding: 2px; font-size: 14px; }
        .action-btn:hover { opacity: 1; transform: scale(1.1); }
        .modal-overlay { position: fixed; top: 0; left: 0; width: 100%; height: 100%; background: rgba(0,0,0,0.5); display: none; justify-content: center; align-items: flex-start; z-index: 100; padding: 10px; box-sizing: border-box; overflow-y: auto; }
        .modal { background: var(--vscode-editorWidget-background); border: 1px solid var(--vscode-widget-border); padding: 15px; border-radius: 4px; width: 90%; max-width: 300px; max-height: calc(100vh - 20px); overflow-y: auto; box-shadow: 0 4px 20px rgba(0,0,0,0.5); margin: auto; }
        .modal h3 { margin-top: 0; font-size: 14px; }
        .modal label { display: block; font-size: 11px; margin-bottom: 4px; opacity: 0.8; }
        .modal input, .modal textarea { width: 100%; background: var(--vscode-input-background); color: var(--vscode-input-foreground); border: 1px solid var(--vscode-input-border); padding: 5px 30px 5px 8px; margin-bottom: 0; border-radius: 2px; box-sizing: border-box; font-family: inherit; }
        .modal input[type="color"] { width: 50px; height: 30px; padding: 0; border: none; cursor: pointer; }
        .modal textarea { height: 60px; resize: vertical; }
        .modal-buttons { display: flex; justify-content: flex-end; gap: 10px; }
        .modal-btn { padding: 4px 12px; cursor: pointer; border-radius: 2px; border: none; background: var(--vscode-button-background); color: var(--vscode-button-foreground); }
        .emoji-picker-container { position: relative; margin-bottom: 10px; display: flex; align-items: center; }
        .emoji-picker-btn { 
            position: absolute; right: 8px; cursor: pointer; font-size: 16px; 
            opacity: 0.6; transition: opacity 0.2s; z-index: 5;
            user-select: none;
        }
        .emoji-picker-btn:hover { opacity: 1; }
        .emoji-picker { 
            position: fixed; 
            background: var(--vscode-editorWidget-background); 
            border: 1px solid var(--vscode-widget-border); border-radius: 4px; 
            display: none; flex-direction: column; width: 240px; height: 300px; 
            z-index: 5000; box-shadow: 0 4px 12px rgba(0,0,0,0.5); 
            opacity: 0; transform: translateY(10px);
            transition: opacity 0.2s, transform 0.2s;
        }
        .emoji-picker.active {
            display: flex; opacity: 1; transform: translateY(0);
        }
        .emoji-picker.compact {
            flex-direction: row; width: 350px; height: 200px;
        }
        .emoji-picker-tabs {
            display: flex; border-bottom: 1px solid var(--vscode-widget-border);
            background: var(--vscode-sideBarSectionHeader-background);
        }
        .emoji-picker.compact .emoji-picker-tabs {
            flex-direction: column; border-bottom: none; border-right: 1px solid var(--vscode-widget-border);
            width: 60px;
        }
        .emoji-picker-tab {
            flex: 1; padding: 8px; text-align: center; cursor: pointer;
            font-size: 11px; opacity: 0.6; border-bottom: 2px solid transparent;
        }
        .emoji-picker.compact .emoji-picker-tab {
            border-bottom: none; border-left: 2px solid transparent;
        }
        .emoji-picker-tab.active {
            opacity: 1; border-bottom-color: var(--vscode-activityBarBadge-background);
            font-weight: bold;
        }
        .emoji-picker.compact .emoji-picker-tab.active {
            border-bottom-color: transparent; border-left-color: var(--vscode-activityBarBadge-background);
        }
        .emoji-picker-content { flex: 1; display: flex; flex-direction: column; overflow: hidden; }
        .emoji-search { padding: 8px; border-bottom: 1px solid var(--vscode-widget-border); }
        .emoji-search input { margin-bottom: 0 !important; font-size: 12px; padding: 4px 8px !important; }
        .emoji-list { flex: 1; overflow-y: auto; display: grid; grid-template-columns: repeat(5, 1fr); padding: 5px; gap: 5px; }
        .emoji-item { 
            cursor: pointer; text-align: center; font-size: 18px; padding: 6px; 
            border-radius: 4px; transition: background 0.1s; display: flex; align-items: center; justify-content: center;
        }
        .emoji-item:hover { background: var(--vscode-list-hoverBackground); }
        .emoji-item i { font-size: 16px; }
        .context-menu { position: fixed; background: var(--vscode-menu-background); color: var(--vscode-menu-foreground); border: 1px solid var(--vscode-menu-border); box-shadow: 0 2px 8px rgba(0,0,0,0.5); z-index: 200; display: none; flex-direction: column; min-width: 120px; border-radius: 4px; padding: 4px 0; }
        .context-menu-item { padding: 6px 12px; cursor: pointer; font-size: 12px; }
        .context-menu-item:hover { background: var(--vscode-menu-selectionBackground); color: var(--vscode-menu-selectionForeground); }
        .drag-over { background-color: var(--vscode-list-dropBackground) !important; }
        .color-picker-row { display: flex; align-items: center; gap: 10px; margin-bottom: 10px; }
        .color-picker-row label { margin-bottom: 0; flex: 1; }
        .color-preview { width: 24px; height: 24px; border-radius: 4px; border: 1px solid var(--vscode-widget-border); }
        .settings-section { margin-bottom: 15px; }
        .settings-section h4 { margin: 0 0 10px 0; font-size: 12px; opacity: 0.8; }
        .toggle-row { display: flex; align-items: center; gap: 10px; margin-bottom: 8px; }
        .toggle-switch { width: 36px; height: 20px; background: var(--vscode-input-background); border-radius: 10px; position: relative; cursor: pointer; transition: background 0.2s; }
        .toggle-switch.active { background: var(--vscode-button-background); }
        .toggle-switch::after { content: ''; position: absolute; width: 16px; height: 16px; background: var(--vscode-foreground); border-radius: 50%; top: 2px; left: 2px; transition: left 0.2s; }
        .toggle-switch.active::after { left: 18px; }
        .path-display { font-size: 11px; opacity: 0.7; word-break: break-all; padding: 5px; background: var(--vscode-input-background); border-radius: 2px; margin-top: 5px; }
        
        .modal-preview-label {
            font-size: 10px;
            opacity: 0.6;
            margin-top: 8px;
            margin-bottom: 4px;
            text-transform: uppercase;
            letter-spacing: 0.5px;
        }
        .modal-preview {
            padding: 8px;
            background: rgba(0,0,0,0.2);
            border-radius: 4px;
            min-height: 24px;
            display: flex;
            align-items: center;
            gap: 8px;
            font-size: 14px;
            margin-bottom: 12px;
            border: 1px solid rgba(255,255,255,0.05);
        }
        .modal-preview i.codicon {
            font-size: 16px;
        }
        
        /* Settings Tabs */
        .settings-tabs { display: flex; border-bottom: 1px solid var(--vscode-widget-border); margin-bottom: 15px; gap: 10px; }
        .settings-tab { padding: 5px 10px; cursor: pointer; opacity: 0.6; font-size: 12px; border-bottom: 2px solid transparent; }
        .settings-tab.active { opacity: 1; border-bottom-color: var(--vscode-activityBarBadge-background); font-weight: bold; }
        .settings-content { display: none; }
        .settings-content.active { display: block; }
        .settings-footer { display: flex; justify-content: flex-end; margin-top: 15px; }
        
        .history-tabs { display: flex; border-bottom: 1px solid var(--vscode-widget-border); margin-bottom: 10px; gap: 10px; }
        .history-tab { padding: 5px 10px; cursor: pointer; opacity: 0.6; font-size: 12px; border-bottom: 2px solid transparent; }
        .history-tab.active { opacity: 1; border-bottom-color: var(--vscode-activityBarBadge-background); font-weight: bold; }
        .history-list { flex: 1; overflow-y: auto; display: none; flex-direction: column; gap: 4px; padding-bottom: 10px; }
        .history-list.active { display: flex; }
        .history-item { 
            padding: 8px 10px; background: var(--vscode-list-inactiveSelectionBackground); 
            border-radius: 4px; cursor: pointer; font-size: 11px; 
            white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
            border-left: 3px solid transparent; flex-shrink: 0;
            display: flex; align-items: center; justify-content: space-between; gap: 8px;
        }
        .history-item:hover { background: var(--vscode-list-hoverBackground); }
        .history-item.copied { border-left-color: #22c55e; }
        .history-item-text { flex: 1; overflow: hidden; text-overflow: ellipsis; }
        .history-item-actions { display: none; gap: 4px; }
        .history-item:hover .history-item-actions { display: flex; }
        .history-action-btn { 
            padding: 2px 4px; border-radius: 3px; background: var(--vscode-button-background); 
            color: var(--vscode-button-foreground); font-size: 10px; cursor: pointer; border: none;
        }
        .history-action-btn:hover { background: var(--vscode-button-hoverBackground); }
        .history-action-btn.disabled { opacity: 0.5; cursor: not-allowed; }
        .history-copy-btn { 
            background: none; border: none; cursor: pointer; opacity: 0; 
            padding: 2px 6px; font-size: 12px; margin-left: auto;
            transition: opacity 0.2s;
        }
        .history-item:hover .history-copy-btn { opacity: 0.6; }
        .history-copy-btn:hover { opacity: 1 !important; transform: scale(1.1); }
        .history-view-container { display: flex; flex-direction: column; height: 100%; }
        .search-container { padding: 8px 10px; border-bottom: 1px solid var(--vscode-widget-border); display: none; }
        .search-container.active { display: block; }
        .search-input { width: 100%; padding: 6px 10px; background: var(--vscode-input-background); color: var(--vscode-input-foreground); border: 1px solid var(--vscode-input-border); border-radius: 4px; font-size: 12px; box-sizing: border-box; }
        .search-input:focus { outline: none; border-color: var(--vscode-focusBorder); }
        .search-input-wrapper { position: relative; display: flex; align-items: center; }
        .search-clear-btn { 
            position: absolute; right: 10px; cursor: pointer; opacity: 0.5; 
            font-size: 14px; display: none; user-select: none;
        }
        .search-clear-btn:hover { opacity: 1; }
        .search-result { padding: 6px 10px; margin: 4px 0; border-radius: 4px; background: var(--vscode-list-inactiveSelectionBackground); cursor: pointer; display: flex; align-items: center; gap: 8px; border-left: 3px solid transparent; }
        .search-result:hover { background: var(--vscode-list-hoverBackground); }
        .search-result-path { font-size: 10px; opacity: 0.6; margin-left: auto; }
        .search-highlight { background: var(--vscode-editor-findMatchHighlightBackground); border-radius: 2px; padding: 0 2px; }
        .version-box { padding: 15px 20px; background: var(--vscode-input-background); border-radius: 8px; cursor: pointer; transition: all 0.2s; border: 2px solid transparent; }
        .version-box:hover { border-color: var(--vscode-focusBorder); transform: scale(1.05); }
        .version-box.outdated { border-color: #f97316; }
        .version-box.current { border-color: #22c55e; }
        .repo-list { max-height: 300px; overflow-y: auto; margin-top: 10px; border: 1px solid var(--vscode-widget-border); border-radius: 4px; }
        .repo-item { padding: 8px 12px; border-bottom: 1px solid var(--vscode-widget-border); cursor: pointer; transition: background 0.2s; }
        .repo-item:last-child { border-bottom: none; }
        .repo-item:hover { background: var(--vscode-list-hoverBackground); }
        .repo-name { font-weight: bold; font-size: 12px; display: flex; align-items: center; gap: 5px; }
        .repo-desc { font-size: 11px; opacity: 0.7; margin-top: 4px; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }
        .repo-meta { font-size: 10px; opacity: 0.5; margin-top: 4px; display: flex; gap: 10px; }
        
        .rich-tooltip {
            position: fixed;
            background: var(--vscode-editorWidget-background);
            color: var(--vscode-editorWidget-foreground);
            border: 1px solid var(--vscode-widget-border);
            box-shadow: 0 4px 12px rgba(0,0,0,0.5);
            padding: 8px 12px;
            border-radius: 4px;
            z-index: 3000;
            pointer-events: none;
            display: none;
            max-width: 300px;
            font-size: 12px;
            line-height: 1.4;
        }
        .tooltip-section { margin-bottom: 8px; }
        .tooltip-section:last-child { margin-bottom: 0; }
        .tooltip-label { font-weight: bold; font-size: 10px; opacity: 0.6; text-transform: uppercase; margin-bottom: 2px; }
        .tooltip-value { word-break: break-all; }
        .tooltip-command { font-family: var(--vscode-editor-font-family); background: rgba(0,0,0,0.2); padding: 2px 4px; border-radius: 2px; }
        
        /* Tab Overflow */
        .tabs-wrapper { display: flex; align-items: center; width: 100%; position: relative; border-bottom: 1px solid var(--vscode-widget-border); }
        .tabs-container { flex: 1; overflow-x: auto; border-bottom: none; display: flex; align-items: center; }
        .tabs-container::-webkit-scrollbar { height: 3px; display: block; }
        .tabs-container::-webkit-scrollbar-track { background: transparent; }
        .tabs-container::-webkit-scrollbar-thumb { background: var(--vscode-scrollbarSlider-background); border-radius: 3px; }
        .tabs-container::-webkit-scrollbar-thumb:hover { background: var(--vscode-scrollbarSlider-hoverBackground); }
        .overflow-btn { 
            padding: 5px 8px; cursor: pointer; opacity: 0.7; font-size: 12px; 
            display: none; align-items: center; justify-content: center;
            border-left: 1px solid var(--vscode-widget-border);
            background: var(--vscode-editor-background);
        }
        .overflow-btn:hover { opacity: 1; background: var(--vscode-list-hoverBackground); }
        .overflow-btn.active { background: var(--vscode-list-activeSelectionBackground); }
        .overflow-menu {
            position: absolute; top: 100%; right: 0;
            background: var(--vscode-dropdown-background);
            border: 1px solid var(--vscode-widget-border);
            box-shadow: 0 4px 12px rgba(0,0,0,0.5);
            border-radius: 0 0 4px 4px;
            z-index: 2000; display: none;
            max-height: 300px; overflow-y: auto;
            min-width: 150px;
        }
        .overflow-menu.active { display: block; }
        .overflow-item {
            padding: 8px 12px; cursor: pointer; font-size: 12px;
            display: flex; align-items: center; gap: 8px;
            border-left: 3px solid transparent;
        }
        .overflow-item:hover { background: var(--vscode-list-hoverBackground); }
        .overflow-item.active { background: var(--vscode-list-activeSelectionBackground); border-left-color: var(--vscode-activityBarBadge-background); }
    </style>
</head>
<body>
    <div id="drop-indicator" class="drop-indicator"></div>
    <div class="sidebar sidebar-left" onclick="if(event.target === this) toggleAllFolders()">
        <div class="side-add-container">
            <button class="side-add-btn" title="Add New...">+</button>
            <div class="side-add-menu">
                <div class="side-add-item" data-label="Add Snippet" onclick="addSnippet()">📄</div>
                <div class="side-add-item" data-label="Add Smart Snippet" onclick="addSmartSnippet()">⚡</div>
                <div class="side-add-item" data-label="Add Folder" onclick="addFolder()">📂</div>
                <div class="side-add-item" data-label="Add Tab" onclick="addTab()">📑</div>
                <div class="side-add-item" data-label="Add Separator" onclick="addSeparator()">➖</div>
            </div>
        </div>
        <div class="side-spacer"></div>
        <button class="side-btn" onclick="openHistory()" title="History">🕒</button>
        <div class="side-spacer"></div>
        <button class="side-btn" onclick="toggleSearch()" title="Search" id="search-btn">🔍</button>
    </div>
    <div class="main-container">
        <div class="tabs-wrapper">
            <div class="execution-toggle-btn" id="execution-toggle" onclick="toggleExecutionMode()">💻</div>
            <div class="tabs-container" id="tabs-container"></div>
            <div class="overflow-btn" id="overflow-btn" onclick="toggleOverflowMenu()" ondragenter="toggleOverflowMenu()" title="Show all tabs">⌄</div>
            <div class="settings-btn" id="settings-btn" onclick="openSettings()" title="Settings">⚙️</div>
            <div class="overflow-menu" id="overflow-menu"></div>
        </div>
        <div class="search-container" id="search-container">
            <div class="search-input-wrapper">
                <input type="text" class="search-input" id="search-input" placeholder="🔍 Search snippets, folders, tabs..." oninput="performSearch()" onkeydown="handleSearchKeydown(event)">
                <span class="search-clear-btn" id="search-clear-btn" onclick="clearSearch()">✕</span>
            </div>
        </div>
        <div class="content" id="content"></div>
    </div>
    <div class="sidebar sidebar-right">
        <button class="side-btn" onclick="cdToActiveFile()" title="CD to Explorer Selection">📂</button>
        <button class="side-btn" id="reload-btn" onclick="reloadExtensions()" title="Reload Extensions" style="display: none;">🔄</button>
        <button class="side-btn" id="version-btn" onclick="checkVersion()" title="Check Version" style="display: none;">📦</button>
        <button class="side-btn" id="github-btn" onclick="openGithubModal()" title="Download GitHub Repos">🐙</button>
    </div>
    <div class="modal-overlay" id="modal-overlay">
        <div class="modal">
            <h3 id="modal-title">Add Snippet</h3>
            <div id="modal-fields"></div>
            <div class="modal-buttons">
                <button class="modal-btn secondary" onclick="closeModal()">Cancel</button>
                <button class="modal-btn" onclick="saveModal()">Save</button>
            </div>
        </div>
    </div>
    <div class="modal-overlay" id="settings-overlay" onclick="if(event.target === this) closeSettings()">
        <div class="modal" style="max-width: 300px;">
            <div style="display: flex; align-items: center; gap: 8px; margin-bottom: 15px;">
                <span style="font-size: 16px;">⚙️</span>
                <h3 style="margin: 0;">Settings</h3>
            </div>
            
            <div class="settings-tabs">
                <div class="settings-tab active" onclick="switchSettingsTab('display')" id="tab-display">Display</div>
                <div class="settings-tab" onclick="switchSettingsTab('config')" id="tab-config">Config</div>
            </div>

            <div id="settings-display" class="settings-content active">
                <div class="toggle-row">
                    <span>Reload Button</span>
                    <div class="toggle-switch" id="toggle-reload" onclick="toggleReloadButton()"></div>
                </div>
                <div class="toggle-row">
                    <span>Confirm Delete</span>
                    <div class="toggle-switch" id="toggle-confirm-delete" onclick="toggleConfirmDelete()"></div>
                </div>
                <div class="toggle-row">
                    <span>GitHub Button</span>
                    <div class="toggle-switch" id="toggle-github" onclick="toggleGithubButton()"></div>
                </div>
                <div style="margin-top: 10px;">
                    <label>GitHub User</label>
                    <input type="text" id="github-username-input" placeholder="e.g. microsoft" onchange="updateGithubUsername(this.value)">
                </div>
                <div class="toggle-row">
                    <span>Version Checker</span>
                    <div class="toggle-switch" id="toggle-version-checker" onclick="toggleVersionChecker()"></div>
                </div>
                <div class="toggle-row">
                    <span>Rich Tooltips</span>
                    <div class="toggle-switch" id="toggle-rich-tooltips" onclick="toggleRichTooltips()"></div>
                </div>
                <div style="margin-top: 10px; display: flex; gap: 10px;">
                    <div style="flex: 1;">
                        <label>Cmd Limit</label>
                        <input type="number" id="cmd-limit-input" min="1" max="100" onchange="updateHistoryLimits()">
                    </div>
                    <div style="flex: 1;">
                        <label>Clip Limit</label>
                        <input type="number" id="clip-limit-input" min="1" max="100" onchange="updateHistoryLimits()">
                    </div>
                </div>
            </div>

            <div id="settings-config" class="settings-content">
                <div style="display: flex; flex-direction: column; gap: 8px;">
                    <button class="modal-btn" onclick="exportConfig()" style="width: 100%;">📤 Export</button>
                    <button class="modal-btn secondary" onclick="importConfig()" style="width: 100%;">📥 Import</button>
                    <button class="modal-btn secondary" onclick="selectConfigPath()" style="width: 100%;">📁 Select File</button>
                </div>
                <div class="path-display" id="config-path-display" style="margin-top: 10px; font-size: 10px;">No config file selected</div>
            </div>

            <div class="settings-footer">
                <button class="modal-btn" onclick="closeSettings()">Close</button>
            </div>
        </div>
    </div>
    <div class="modal-overlay" id="github-overlay">
        <div class="modal" style="max-width: 400px;">
            <h3>🐙 Download GitHub Repos</h3>
            <div style="display: flex; gap: 8px; margin-bottom: 10px;">
                <input type="text" id="github-search-user" placeholder="Enter GitHub username..." style="margin-bottom: 0;">
                <button class="modal-btn" onclick="fetchRepos()">Fetch</button>
            </div>
            <div id="github-status" style="font-size: 11px; opacity: 0.7; margin-bottom: 5px;"></div>
            <div class="repo-list" id="repo-list">
                <div style="padding: 20px; text-align: center; opacity: 0.5;">Enter a username to see repositories</div>
            </div>
            <div class="modal-buttons" style="margin-top: 15px;">
                <button class="modal-btn secondary" onclick="closeGithubModal()">Close</button>
            </div>
        </div>
    </div>
    <div class="modal-overlay" id="version-overlay">
        <div class="modal" style="max-width: 350px; text-align: center;">
            <h3>📦 Version Info</h3>
            <div id="version-loading" style="padding: 20px;">Loading...</div>
            <div id="version-content" style="display: none;">
                <div id="version-project" style="font-weight: bold; font-size: 16px; margin-bottom: 15px;"></div>
                <div style="display: flex; justify-content: space-around; gap: 15px;">
                    <div class="version-box" onclick="copyVersion('local')" title="Click to copy">
                        <div style="font-size: 11px; opacity: 0.7;">LOCAL</div>
                        <div id="version-local" style="font-size: 18px; font-weight: bold; cursor: pointer;">-</div>
                    </div>
                    <div style="display: flex; align-items: center; font-size: 24px;" id="version-status">⟷</div>
                    <div class="version-box" onclick="copyVersion('remote')" title="Click to copy">
                        <div style="font-size: 11px; opacity: 0.7;">REMOTE</div>
                        <div id="version-remote" style="font-size: 18px; font-weight: bold; cursor: pointer;">-</div>
                    </div>
                </div>
                <div id="version-repo" style="margin-top: 15px; font-size: 11px; opacity: 0.7; word-break: break-all;"></div>
            </div>
            <div class="modal-buttons" style="margin-top: 15px; justify-content: center;">
                <button class="modal-btn secondary" onclick="closeVersionModal()">Close</button>
                <button class="modal-btn" onclick="checkVersion()">🔄 Refresh</button>
            </div>
        </div>
    </div>
    <div class="modal-overlay" id="color-picker-overlay">
        <div class="modal" style="max-width: 250px;">
            <h3>🎨 Choose Color</h3>
            <div class="color-picker-row">
                <label>Color:</label>
                <input type="color" id="color-input" value="#ffffff">
                <div class="color-preview" id="color-preview"></div>
            </div>
            <div id="recursive-color-row" style="display: none; margin-bottom: 10px; align-items: center; gap: 8px;">
                <input type="checkbox" id="recursive-color-check" style="width: auto; margin: 0;">
                <label style="margin: 0; font-size: 11px;">Apply to children</label>
            </div>
            <div style="margin-bottom: 10px;">
                <button class="modal-btn secondary" onclick="setPresetColor('')" style="padding: 2px 8px; margin: 2px;">Default</button>
                <button class="modal-btn secondary" onclick="setPresetColor('#ef4444')" style="padding: 2px 8px; margin: 2px; background: #ef4444;">🔴</button>
                <button class="modal-btn secondary" onclick="setPresetColor('#f97316')" style="padding: 2px 8px; margin: 2px; background: #f97316;">🟠</button>
                <button class="modal-btn secondary" onclick="setPresetColor('#eab308')" style="padding: 2px 8px; margin: 2px; background: #eab308;">🟡</button>
                <button class="modal-btn secondary" onclick="setPresetColor('#22c55e')" style="padding: 2px 8px; margin: 2px; background: #22c55e;">🟢</button>
                <button class="modal-btn secondary" onclick="setPresetColor('#3b82f6')" style="padding: 2px 8px; margin: 2px; background: #3b82f6;">🔵</button>
                <button class="modal-btn secondary" onclick="setPresetColor('#a855f7')" style="padding: 2px 8px; margin: 2px; background: #a855f7;">🟣</button>
            </div>
            <div class="modal-buttons">
                <button class="modal-btn secondary" onclick="closeColorPicker()">Cancel</button>
                <button class="modal-btn" onclick="applyColor()">Apply</button>
            </div>
        </div>
    </div>
    <div class="modal-overlay" id="confirm-overlay">
        <div class="modal" style="max-width: 280px; text-align: center;">
            <h3>⚠️ Confirm Delete</h3>
            <p id="confirm-message" style="margin: 15px 0;">Are you sure?</p>
            <div class="modal-buttons" style="justify-content: center;">
                <button class="modal-btn secondary" onclick="confirmNo()">Cancel</button>
                <button class="modal-btn" onclick="confirmYes()" style="background: #ef4444;">Delete</button>
            </div>
        </div>
    </div>
    <div class="context-menu" id="context-menu"></div>
    <div id="rich-tooltip" class="rich-tooltip"></div>
    <script>
        const vscode = acquireVsCodeApi();
        let items = [];
        let activeTabId = null;
        let currentModalCallback = null;
        let contextMenuItemId = null;
        let colorPickerItemId = null;
        let confirmCallback = null;
        let searchMode = false;
        let settings = { showReloadButton: false, configFilePath: '', confirmDelete: false, showVersionChecker: false, executionMode: 'terminal', commandHistoryLimit: 20, clipboardHistoryLimit: 20 };
        let commandHistory = [];
        let clipboardHistory = [];

        // Helper function to check if parentId is "root" (null or undefined)
        function isRootItem(item) {
            return item.parentId === null || item.parentId === undefined;
        }

        function matchesParent(item, parentId) {
            if (parentId === undefined) {
                return isRootItem(item);
            }
            return item.parentId === parentId;
        }

        function isDescendant(parentId, childId) {
            let current = items.find(i => i.id === childId);
            const visited = new Set();
            while (current && current.parentId) {
                if (visited.has(current.id)) break; // Safety
                visited.add(current.id);
                if (current.parentId === parentId) return true;
                current = items.find(i => i.id === current.parentId);
            }
            return false;
        }

        let lastActiveTabId = null;

        function openHistory() {
            if (activeTabId === 'history') {
                // Toggle back to previous tab
                activeTabId = lastActiveTabId || (items.some(i => isRootItem(i) && i.type !== 'tab') ? 'root' : (items.find(i => i.type === 'tab')?.id || null));
                render();
            } else {
                lastActiveTabId = activeTabId;
                activeTabId = 'history';
                render();
            }
        }

        window.addEventListener('message', event => {
            const message = event.data;
            switch (message.type) {
                case 'loadItems':
                    items = message.items;
                    const hasRootItems = items.some(i => isRootItem(i) && i.type !== 'tab');
                    if (!activeTabId) {
                        if (hasRootItems) {
                            activeTabId = 'root';
                        } else if (items.some(i => i.type === 'tab')) {
                            activeTabId = items.find(i => i.type === 'tab').id;
                        }
                    } else if (activeTabId !== 'root' && activeTabId !== 'history' && !items.some(i => i.id === activeTabId)) {
                        activeTabId = hasRootItems ? 'root' : (items.find(i => i.type === 'tab')?.id || null);
                    }
                    render();
                    break;
                case 'loadSettings':
                    settings = message.settings || { showReloadButton: false, configFilePath: '', confirmDelete: false, showVersionChecker: false, githubUsername: '', showGithubButton: true, executionMode: 'terminal', enableRichTooltips: true, commandHistoryLimit: 20, clipboardHistoryLimit: 20 };
                    updateSettingsUI();
                    break;
                case 'loadHistory':
                    if (message.commandHistory) commandHistory = message.commandHistory;
                    if (message.clipboardHistory) clipboardHistory = message.clipboardHistory;
                    renderHistory();
                    break;
                case 'openHistory':
                    openHistory();
                    break;
                case 'versionInfo':
                    displayVersionInfo(message);
                    break;
                case 'triggerAddSnippet': addSnippet(); break;
                case 'triggerAddTab': addTab(); break;
                case 'inputResponse': if (currentModalCallback) currentModalCallback(message.value); break;
                case 'githubReposResponse': displayGithubRepos(message.repos); break;
                case 'githubReposError': displayGithubError(message.message); break;
            }
        });

        function updateSettingsUI() {
            const reloadBtn = document.getElementById('reload-btn');
            const versionBtn = document.getElementById('version-btn');
            const toggleReload = document.getElementById('toggle-reload');
            const toggleConfirmDelete = document.getElementById('toggle-confirm-delete');
            const toggleVersionChecker = document.getElementById('toggle-version-checker');
            const toggleRichTooltips = document.getElementById('toggle-rich-tooltips');
            const pathDisplay = document.getElementById('config-path-display');
            
            if (reloadBtn) reloadBtn.style.display = settings.showReloadButton ? 'flex' : 'none';
            if (versionBtn) versionBtn.style.display = settings.showVersionChecker ? 'flex' : 'none';
            if (toggleReload) toggleReload.classList.toggle('active', settings.showReloadButton);
            if (toggleConfirmDelete) toggleConfirmDelete.classList.toggle('active', settings.confirmDelete);
            if (toggleVersionChecker) toggleVersionChecker.classList.toggle('active', settings.showVersionChecker);
            if (toggleRichTooltips) toggleRichTooltips.classList.toggle('active', settings.enableRichTooltips);
            if (pathDisplay) pathDisplay.textContent = settings.configFilePath || 'No config file selected';
            
            const githubBtn = document.getElementById('github-btn');
            const toggleGithub = document.getElementById('toggle-github');
            if (githubBtn) githubBtn.style.display = settings.showGithubButton ? 'flex' : 'none';
            if (toggleGithub) toggleGithub.classList.toggle('active', settings.showGithubButton);
            
            const githubInput = document.getElementById('github-username-input');
            if (githubInput) githubInput.value = settings.githubUsername || '';
            
            const cmdLimitInput = document.getElementById('cmd-limit-input');
            const clipLimitInput = document.getElementById('clip-limit-input');
            if (cmdLimitInput) cmdLimitInput.value = settings.commandHistoryLimit || 20;
            if (clipLimitInput) clipLimitInput.value = settings.clipboardHistoryLimit || 20;
            
            updateExecutionModeUI();
            checkToolbarLayout();
        }

        function toggleExecutionMode() {
            const modes = ['terminal', 'editor', 'locked'];
            let idx = modes.indexOf(settings.executionMode || 'terminal');
            settings.executionMode = modes[(idx + 1) % modes.length];
            vscode.postMessage({ type: 'saveSettings', settings });
            updateExecutionModeUI();
            render(); // Re-render to update drag handles and classes
        }

        function toggleRichTooltips() {
            settings.enableRichTooltips = !settings.enableRichTooltips;
            vscode.postMessage({ type: 'saveSettings', settings });
            updateSettingsUI();
        }

        function updateExecutionModeUI() {
            const btn = document.getElementById('execution-toggle');
            if (btn) {
                const mode = settings.executionMode || 'terminal';
                if (mode === 'terminal') {
                    btn.innerText = '💻';
                    btn.title = 'Execution Mode: Terminal (Click to switch)';
                } else if (mode === 'editor') {
                    btn.innerText = '📝';
                    btn.title = 'Execution Mode: Editor (Click to switch)';
                } else {
                    btn.innerText = '🔒';
                    btn.title = 'Execution Mode: Locked (Reorganize only, click to switch)';
                }
            }
            document.body.classList.toggle('locked-mode', settings.executionMode === 'locked');
        }

        function resetDropIndicator() {
            const indicator = document.getElementById('drop-indicator');
            if (!indicator) return;
            indicator.style.display = 'none';
            indicator.style.width = '';
            indicator.style.height = '';
            indicator.style.top = '';
            indicator.style.left = '';
            indicator.classList.remove('vertical');
        }

        function startInlineEdit(el, item) {
            if (settings.executionMode !== 'locked') return;
            
            const nameEl = el.querySelector('.snippet-name') || el.querySelector('.folder-name') || el;
            const originalName = item.name;
            const input = document.createElement('input');
            input.type = 'text';
            input.className = 'inline-edit-input';
            input.value = originalName;
            
            const finishEdit = (saveChanges) => {
                if (saveChanges && input.value.trim() !== '') {
                    item.name = input.value.trim();
                    save();
                }
                render();
            };

            input.onkeydown = (e) => {
                if (e.key === 'Enter') finishEdit(true);
                if (e.key === 'Escape') finishEdit(false);
            };
            input.onblur = () => finishEdit(true);

            nameEl.innerHTML = '';
            nameEl.appendChild(input);
            input.focus();
            input.select();
        }

        function toggleAllFolders() {
            const currentTabId = activeTabId === 'root' ? undefined : activeTabId;
            const tabFolders = items.filter(i => i.type === 'folder' && matchesParent(i, currentTabId));
            if (tabFolders.length === 0) return;
            
            const anyExpanded = tabFolders.some(f => f.expanded);
            tabFolders.forEach(f => f.expanded = !anyExpanded);
            save(); render();
        }

        function checkFabMenuLayout() {
            const container = document.querySelector('.side-add-container');
            const menu = document.querySelector('.side-add-menu');
            if (!container || !menu) return;
            
            const rect = container.getBoundingClientRect();
            const availableSpaceBelow = window.innerHeight - rect.top;
            const menuHeight = 220; // Approximate height of vertical menu
            
            if (availableSpaceBelow < menuHeight) {
                menu.classList.add('horizontal');
            } else {
                menu.classList.remove('horizontal');
            }
        }

        function checkRightSidebarLayout() {
            const sidebar = document.querySelector('.sidebar-right');
            const body = document.body;
            if (!sidebar) return;

            const iconsCount = sidebar.querySelectorAll('.side-btn:not([style*="display: none"])').length;
            const requiredHeight = iconsCount * 44 + 20; // 44px per icon + padding
            
            if (window.innerHeight < requiredHeight) {
                sidebar.classList.add('horizontal');
                // Move sidebar to bottom of main-container if not already there
                const mainContainer = document.querySelector('.main-container');
                if (sidebar.parentElement === body) {
                    mainContainer.appendChild(sidebar);
                }
            } else {
                sidebar.classList.remove('horizontal');
                // Move sidebar back to body (after main-container)
                if (sidebar.parentElement !== body) {
                    body.appendChild(sidebar);
                }
            }
        }

        function checkOverflow() {
            const container = document.getElementById('tabs-container');
            const btn = document.getElementById('overflow-btn');
            if (!container || !btn) return;

            if (container.scrollWidth > container.clientWidth) {
                btn.style.display = 'flex';
            } else {
                btn.style.display = 'none';
                document.getElementById('overflow-menu').classList.remove('active');
                btn.classList.remove('active');
            }
        }

        function toggleOverflowMenu() {
            const menu = document.getElementById('overflow-menu');
            const btn = document.getElementById('overflow-btn');
            const isActive = menu.classList.contains('active');
            
            if (isActive) {
                menu.classList.remove('active');
                btn.classList.remove('active');
            } else {
                renderOverflowMenu();
                menu.classList.add('active');
                btn.classList.add('active');
            }
        }

        function renderOverflowMenu() {
            const menu = document.getElementById('overflow-menu');
            const container = document.getElementById('tabs-container');
            const containerRect = container.getBoundingClientRect();
            menu.innerHTML = '';
            
            const tabs = items.filter(i => i.type === 'tab');
            const hasRootItems = items.some(i => isRootItem(i) && i.type !== 'tab');
            
            if (hasRootItems) {
                tabs.unshift({ id: 'root', name: '🏠', type: 'tab' });
            }

            let hasHiddenTabs = false;

            tabs.forEach(tab => {
                // Find the tab element in the main bar
                const tabEl = Array.from(container.children).find(el => el.innerText === tab.name && el.classList.contains('tab'));
                
                // Check visibility
                let isVisible = false;
                if (tabEl) {
                    const rect = tabEl.getBoundingClientRect();
                    isVisible = (rect.left >= containerRect.left && rect.right <= containerRect.right);
                }

                if (!isVisible) {
                    hasHiddenTabs = true;
                    const item = document.createElement('div');
                    item.className = 'overflow-item' + (tab.id === activeTabId ? ' active' : '');
                    item.innerHTML = parseIcons(tab.name);
                    if (tab.color) item.style.color = tab.color;
                    
                    item.onclick = () => {
                        activeTabId = tab.id;
                        render();
                        toggleOverflowMenu();
                        
                        // Scroll tab into view
                        setTimeout(() => {
                            const targetTab = Array.from(document.querySelectorAll('.tab')).find(el => el.innerText === tab.name);
                            if (targetTab) targetTab.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'center' });
                        }, 50);
                    };

                    // Drag & Drop Support
                    let hoverTimer;
                    item.ondragover = (e) => {
                        e.preventDefault();
                        item.style.background = 'var(--vscode-list-hoverBackground)';
                        
                        if (activeTabId !== tab.id && !hoverTimer) {
                            hoverTimer = setTimeout(() => {
                                activeTabId = tab.id;
                                render();
                                toggleOverflowMenu(); 
                                
                                // Scroll tab into view
                                setTimeout(() => {
                                    const targetTab = Array.from(document.querySelectorAll('.tab')).find(el => el.innerText === tab.name);
                                    if (targetTab) targetTab.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'center' });
                                }, 50);
                            }, 500);
                        }
                    };
                    item.ondragleave = () => {
                        item.style.background = '';
                        if (hoverTimer) {
                            clearTimeout(hoverTimer);
                            hoverTimer = null;
                        }
                    };
                    item.ondrop = (e) => {
                        e.preventDefault();
                        item.style.background = '';
                        if (hoverTimer) clearTimeout(hoverTimer);
                        
                        const draggedId = e.dataTransfer.getData('text/plain');
                        const draggedItem = items.find(i => i.id === draggedId);
                        
                        if (draggedItem && draggedItem.type !== 'tab') {
                            draggedItem.parentId = tab.id === 'root' ? undefined : tab.id;
                            save(); render();
                            toggleOverflowMenu(); // Close menu after drop
                        }
                    };

                    menu.appendChild(item);
                }
            });

            if (!hasHiddenTabs) {
                const empty = document.createElement('div');
                empty.className = 'overflow-item';
                empty.style.opacity = '0.5';
                empty.style.cursor = 'default';
                empty.innerText = 'No hidden tabs';
                menu.appendChild(empty);
            }
        }

        window.addEventListener('resize', () => {
            checkFabMenuLayout();
            checkRightSidebarLayout();
            checkOverflow();
        });
        document.querySelector('.side-add-container').addEventListener('mouseenter', checkFabMenuLayout);
        
        // Close overflow menu when clicking outside
        document.addEventListener('click', (e) => {
            const menu = document.getElementById('overflow-menu');
            const btn = document.getElementById('overflow-btn');
            if (menu.classList.contains('active') && !menu.contains(e.target) && !btn.contains(e.target)) {
                menu.classList.remove('active');
                btn.classList.remove('active');
            }
        });
        
        // Initial check
        setTimeout(() => {
            checkFabMenuLayout();
            checkRightSidebarLayout();
            checkOverflow();
        }, 100);

        function save() { vscode.postMessage({ type: 'saveItems', items }); }

        function parseIcons(text) {
            if (!text) return '';
            // Replace $(icon-name) with codicon. 
            // We strip HTML tags from the name in case highlightMatch inserted some.
            return text.replace(/\\\$\\(([^)]+)\\)/g, (match, name) => {
                const cleanName = name.replace(/<[^>]*>/g, '');
                return \`<i class="codicon codicon-\${cleanName}"></i>\`;
            });
        }

        function render() {
            const tabsContainer = document.getElementById('tabs-container');
            const content = document.getElementById('content');
            tabsContainer.innerHTML = '';
            content.innerHTML = '';
            
            // Allow dropping on content to move to root of active tab
            content.ondragover = (e) => {
                e.preventDefault();
                if (e.target === content) {
                    content.classList.add('drag-over');
                }
            };
            content.ondragleave = () => content.classList.remove('drag-over');
            content.ondrop = (e) => {
                e.preventDefault();
                content.classList.remove('drag-over');
                if (e.target === content) {
                    const draggedId = e.dataTransfer.getData('text/plain');
                    const draggedItem = items.find(i => i.id === draggedId);
                    if (draggedItem) {
                        draggedItem.parentId = activeTabId === 'root' ? undefined : activeTabId;
                        // Move to end of list
                        const idx = items.indexOf(draggedItem);
                        items.splice(idx, 1);
                        items.push(draggedItem);
                        save(); render();
                    }
                }
            };

            const tabs = items.filter(i => i.type === 'tab');
            const hasRootItems = items.some(i => isRootItem(i) && i.type !== 'tab');
            
            updateExecutionModeUI();

            if (hasRootItems) {
                tabs.unshift({ id: 'root', name: '🏠', type: 'tab' });
            }
            

            tabs.forEach(tab => {
                const el = document.createElement('div');
                el.className = 'tab' + (tab.id === activeTabId ? ' active' : '');
                el.innerHTML = parseIcons(tab.name);
                el.ondblclick = (e) => { e.stopPropagation(); startInlineEdit(el, tab); };
                
                if (tab.color) {
                    el.style.color = tab.color;
                    el.style.opacity = '1';
                }
                if (tab.id === activeTabId) {
                    el.style.borderBottomColor = tab.color || 'var(--vscode-activityBarBadge-background)';
                }

                let hoverTimer;
                el.onclick = () => { 
                    if (activeTabId !== tab.id) {
                        activeTabId = tab.id; 
                        render(); 
                    }
                };
                el.ondblclick = (e) => { 
                    e.stopPropagation(); 
                    if (tab.id !== 'root') startInlineEdit(el, tab); 
                };
                el.draggable = true;
                el.ondragstart = (e) => { e.dataTransfer.setData('text/plain', tab.id); el.classList.add('dragging'); };
                el.ondragend = () => {
                    el.classList.remove('dragging');
                    resetDropIndicator();
                    if (hoverTimer) clearTimeout(hoverTimer);
                };
                el.ondragover = (e) => {
                    e.preventDefault();
                    
                    // Hover to open tab logic
                    if (activeTabId !== tab.id && !hoverTimer) {
                        hoverTimer = setTimeout(() => {
                            activeTabId = tab.id;
                            render();
                        }, 500);
                    }

                    resetDropIndicator();
                    const indicator = document.getElementById('drop-indicator');
                    const rect = el.getBoundingClientRect();
                    const midpoint = rect.left + rect.width / 2;
                    
                    indicator.style.display = 'block';
                    indicator.classList.add('vertical');
                    indicator.style.height = rect.height + 'px';
                    indicator.style.top = rect.top + 'px';
                    
                    if (e.clientX < midpoint) {
                        indicator.style.left = rect.left + 'px';
                        el.dataset.dropPos = 'before';
                    } else {
                        indicator.style.left = rect.right + 'px';
                        el.dataset.dropPos = 'after';
                    }
                };
                el.ondragleave = () => {
                    resetDropIndicator();
                    if (hoverTimer) {
                        clearTimeout(hoverTimer);
                        hoverTimer = null;
                    }
                };
                el.ondrop = (e) => {
                    e.preventDefault();
                    resetDropIndicator();
                    if (hoverTimer) {
                        clearTimeout(hoverTimer);
                        hoverTimer = null;
                    }
                    
                    const draggedId = e.dataTransfer.getData('text/plain');
                    const draggedItem = items.find(i => i.id === draggedId);
                    if (!draggedItem) return;
                    
                    if (draggedItem.type === 'tab') {
                        const fromIdx = items.indexOf(draggedItem);
                        let toIdx = items.indexOf(tab);
                        const dropPos = el.dataset.dropPos;
                        
                        items.splice(fromIdx, 1);
                        toIdx = items.indexOf(tab);
                        
                        if (dropPos === 'after') {
                            items.splice(toIdx + 1, 0, draggedItem);
                        } else {
                            items.splice(toIdx, 0, draggedItem);
                        }
                        save(); render();
                    } else {
                        draggedItem.parentId = tab.id === 'root' ? undefined : tab.id;
                        save(); render();
                    }
                };
                el.oncontextmenu = (e) => {
                    e.preventDefault();
                    showContextMenu(e.clientX, e.clientY, tab.id);
                };
                tabsContainer.appendChild(el);
            });

            if (activeTabId === 'history') {
                renderHistoryView(content);
            } else {
                renderItems(activeTabId === 'root' ? undefined : activeTabId, content);
            }
            
            // Check for tab overflow
            setTimeout(checkOverflow, 0);
        }

        function renderItems(parentId, container) {
            const children = items.filter(i => matchesParent(i, parentId) && i.type !== 'tab');
            if (children.length === 0 && container.id === 'content') {
                container.innerHTML = '<div class="empty-state" style="opacity: 0.5; padding: 20px; text-align: center;">No items here</div>';
                return;
            }

            children.forEach(item => {
                if (item.type === 'folder') {
                    const folderEl = document.createElement('div');
                    folderEl.className = 'folder-item' + (item.expanded ? ' expanded' : '');
                    folderEl.setAttribute('data-id', item.id);
                    
                    const header = document.createElement('div');
                    header.className = 'folder-header';
                    header.style.borderLeftColor = item.color || 'transparent';
                    header.style.color = item.color || 'inherit';
                    
                    header.innerHTML = '<div class="drag-handle" draggable="true">⠿</div>' +
                        '<div class="folder-toggle">▶</div>' +
                        '<div class="snippet-name">📁 ' + parseIcons(item.name) + '</div>' +
                        '<div class="actions">' +
                            '<button class="action-btn" onclick="event.stopPropagation(); editItem(\\'' + item.id + '\\')">✎</button>' +
                            '<button class="action-btn" onclick="event.stopPropagation(); deleteItem(\\'' + item.id + '\\')">🗑</button>' +
                        '</div>';
                    
                    header.onclick = (e) => {
                        item.expanded = !item.expanded;
                        folderEl.classList.toggle('expanded');
                        save();
                    };
                    header.ondblclick = (e) => { e.stopPropagation(); startInlineEdit(header, item); };
                    header.onmouseenter = (e) => TooltipManager.show(e, item);
                    header.onmousemove = (e) => TooltipManager.move(e);
                    header.onmouseleave = () => TooltipManager.hide();

                    const folderContent = document.createElement('div');
                    folderContent.className = 'folder-content';
                    renderItems(item.id, folderContent);

                    folderEl.appendChild(header);
                    folderEl.appendChild(folderContent);
                    
                    setupDragDrop(header, item);
                    container.appendChild(folderEl);
                } else if (item.type === 'separator') {
                    const el = document.createElement('div');
                    el.className = 'snippet-item separator';
                    el.setAttribute('data-id', item.id);
                    el.innerHTML = '<div class="drag-handle" draggable="true">⠿</div>' +
                        '<div style="flex: 1; height: ' + (item.color ? '4px' : '2px') + '; background-color: ' + (item.color || 'var(--vscode-foreground)') + '; opacity: ' + (item.color ? '1' : '0.3') + '; margin: 0 4px; border-radius: 2px;"></div>' +
                        '<div class="actions" style="position: absolute; right: 5px; top: -12px; background: var(--vscode-editorWidget-background); border: 1px solid var(--vscode-widget-border); border-radius: 4px; padding: 2px; display: none; z-index: 10;">' +
                            '<button class="action-btn" onclick="event.stopPropagation(); deleteItem(\\'' + item.id + '\\')">🗑</button>' +
                        '</div>';
                    el.onmouseenter = () => { const a = el.querySelector('.actions'); if(a) a.style.display = 'flex'; };
                    el.onmouseleave = () => { const a = el.querySelector('.actions'); if(a) a.style.display = 'none'; };
                    setupDragDrop(el, item);
                    container.appendChild(el);
                } else {
                    const el = document.createElement('div');
                    el.className = 'snippet-item';
                    el.setAttribute('data-id', item.id);
                    
                    el.style.borderLeftColor = item.color || 'transparent';
                    el.style.color = item.color || 'inherit';
                    const isSmart = item.command && item.command.includes('{{arg$');
                    
                    el.innerHTML = '<div class="drag-handle" draggable="true">⠿</div>' +
                        '<div class="snippet-name">' + parseIcons(item.name) + (isSmart ? '<span class="smart-badge" title="Smart Snippet">⚡</span>' : '') + '</div>' +
                        '<div class="snippet-command">' + (item.command || '') + '</div>' +
                        '<div class="actions">' +
                            '<button class="action-btn" onclick="event.stopPropagation(); editItem(\\'' + item.id + '\\')">✎</button>' +
                            '<button class="action-btn" onclick="event.stopPropagation(); deleteItem(\\'' + item.id + '\\')">🗑</button>' +
                        '</div>';
                    
                    el.ondblclick = (e) => { e.stopPropagation(); startInlineEdit(el, item); };
                    el.onclick = (e) => {
                        if (settings.executionMode === 'locked') return;
                        vscode.postMessage({ type: 'executeCommand', command: item.command });
                    };
                    el.onmouseenter = (e) => TooltipManager.show(e, item);
                    el.onmousemove = (e) => TooltipManager.move(e);
                    el.onmouseleave = () => TooltipManager.hide();
                    setupDragDrop(el, item);
                    container.appendChild(el);
                }
            });
        }

        function setupDragDrop(el, item) {
            const handle = (settings.executionMode === 'locked') ? el : (el.querySelector('.drag-handle') || el);
            handle.draggable = true;
            handle.ondragstart = (e) => {
                // Prevent dragging if clicking on buttons
                if (e.target.closest('.actions') || e.target.closest('.folder-toggle')) {
                    e.preventDefault();
                    return;
                }
                e.dataTransfer.setData('text/plain', item.id);
                el.classList.add('dragging');
                e.stopPropagation();
            };
            handle.ondragend = () => {
                el.classList.remove('dragging');
                resetDropIndicator();
            };

            let expandTimer;
            el.ondragover = (e) => {
                e.preventDefault();
                e.stopPropagation();
                
                resetDropIndicator();
                const indicator = document.getElementById('drop-indicator');
                const rect = el.getBoundingClientRect();
                const midpoint = rect.top + rect.height / 2;
                
                indicator.style.display = 'block';
                indicator.style.width = rect.width + 'px';
                indicator.style.left = rect.left + 'px';
                
                if (e.clientY < midpoint) {
                    indicator.style.top = rect.top + 'px';
                    el.dataset.dropPos = 'before';
                } else {
                    indicator.style.top = rect.bottom + 'px';
                    el.dataset.dropPos = 'after';
                }
                
                if (item.type === 'folder' && e.clientX > rect.left + 20) {
                    el.classList.add('drag-over');
                    indicator.style.display = 'none';
                    el.dataset.dropPos = 'inside';
                    
                    if (!item.expanded && !expandTimer) {
                        expandTimer = setTimeout(() => {
                            item.expanded = true;
                            save(); render();
                        }, 600);
                    }
                } else {
                    el.classList.remove('drag-over');
                    if (expandTimer) {
                        clearTimeout(expandTimer);
                        expandTimer = null;
                    }
                }
            };
            
            el.ondragleave = () => {
                el.classList.remove('drag-over');
                resetDropIndicator();
                if (expandTimer) {
                    clearTimeout(expandTimer);
                    expandTimer = null;
                }
            };
            
            el.ondrop = (e) => {
                e.preventDefault();
                e.stopPropagation();
                el.classList.remove('drag-over');
                resetDropIndicator();
                if (expandTimer) {
                    clearTimeout(expandTimer);
                    expandTimer = null;
                }
                
                const draggedId = e.dataTransfer.getData('text/plain');
                const draggedItem = items.find(i => i.id === draggedId);
                if (!draggedItem || draggedItem.id === item.id) return;

                // Prevent circular references
                if (item.type === 'folder' && isDescendant(draggedItem.id, item.id)) {
                    return;
                }

                const dropPos = el.dataset.dropPos;
                
                if (dropPos === 'inside' && item.type === 'folder') {
                    draggedItem.parentId = item.id;
                    item.expanded = true;
                } else {
                    draggedItem.parentId = item.parentId;
                    const fromIdx = items.indexOf(draggedItem);
                    let toIdx = items.indexOf(item);
                    
                    items.splice(fromIdx, 1);
                    // Re-calculate toIdx after removal
                    toIdx = items.indexOf(item);
                    
                    if (dropPos === 'after') {
                        items.splice(toIdx + 1, 0, draggedItem);
                    } else {
                        items.splice(toIdx, 0, draggedItem);
                    }
                }
                save(); render();
            };
            el.oncontextmenu = (e) => { e.preventDefault(); e.stopPropagation(); showContextMenu(e.clientX, e.clientY, item.id); };
        }

        function addSnippet() {
            showModal('Add Snippet', [
                { id: 'name', label: 'Name', placeholder: 'My Snippet' },
                { id: 'command', label: 'Command', placeholder: 'npm start' },
                { id: 'description', label: 'Description', placeholder: 'Short description...', type: 'textarea' }
            ], (data) => {
                items.push({ id: Date.now().toString(), name: data.name, command: data.command, description: data.description, type: 'snippet', parentId: activeTabId === 'root' ? undefined : activeTabId });
                save(); render();
            });
        }

        function addSmartSnippet() {
            showModal('Add Smart Snippet', [
                { id: 'name', label: 'Name', placeholder: 'Git Release' },
                { id: 'command', label: 'Command', placeholder: 'git tag -a {{arg$1:Version}} -m "{{arg$2:Comment}}"' },
                { id: 'description', label: 'Description', placeholder: 'Short description...', type: 'textarea' }
            ], (data) => {
                items.push({ id: Date.now().toString(), name: data.name, command: data.command, description: data.description, type: 'snippet', parentId: activeTabId === 'root' ? undefined : activeTabId });
                save(); render();
            });
        }

        function addFolder() {
            showModal('Add Folder', [{ id: 'name', label: 'Folder Name', placeholder: 'New Folder' }], (data) => {
                items.push({ id: Date.now().toString(), name: data.name, type: 'folder', expanded: true, parentId: activeTabId === 'root' ? undefined : activeTabId });
                save(); render();
            });
        }

        function addTab() {
            showModal('Add Tab', [{ id: 'name', label: 'Tab Name', placeholder: 'New Tab' }], (data) => {
                const id = Date.now().toString();
                items.push({ id, name: data.name, type: 'tab' });
                activeTabId = id;
                save(); render();
            });
        }

        function addSeparator() {
            items.push({ id: Date.now().toString(), name: '---', type: 'separator', parentId: activeTabId === 'root' ? undefined : activeTabId });
            save(); render();
        }

        function editItem(id) {
            const item = items.find(i => i.id === id);
            if (item.type === 'tab') {
                showModal('Edit Tab', [{ id: 'name', label: 'Tab Name', value: item.name }], (data) => { item.name = data.name; save(); render(); });
            } else if (item.type === 'folder') {
                showModal('Edit Folder', [{ id: 'name', label: 'Folder Name', value: item.name }], (data) => { item.name = data.name; save(); render(); });
            } else {
                showModal('Edit Snippet', [
                    { id: 'name', label: 'Name', value: item.name },
                    { id: 'command', label: 'Command', value: item.command },
                    { id: 'description', label: 'Description', value: item.description, type: 'textarea' }
                ], (data) => { item.name = data.name; item.command = data.command; item.description = data.description; save(); render(); });
            }
        }

        function deleteItem(id) {
            if (settings.confirmDelete) {
                showConfirmDialog('Are you sure you want to delete this item?', () => performDelete(id));
            } else {
                performDelete(id);
            }
        }

        function performDelete(id) {
            const deletedItem = items.find(i => i.id === id);
            if (deletedItem && (deletedItem.type === 'folder' || deletedItem.type === 'tab')) {
                items.forEach(i => { if (i.parentId === id) i.parentId = deletedItem.parentId; });
            }
            items = items.filter(i => i.id !== id);
            if (activeTabId === id) activeTabId = 'root';
            save(); render();
        }

        function showConfirmDialog(message, onConfirm) {
            confirmCallback = onConfirm;
            document.getElementById('confirm-message').textContent = message;
            document.getElementById('confirm-overlay').style.display = 'flex';
        }

        function confirmYes() {
            document.getElementById('confirm-overlay').style.display = 'none';
            if (confirmCallback) confirmCallback();
            confirmCallback = null;
        }

        function confirmNo() {
            document.getElementById('confirm-overlay').style.display = 'none';
            confirmCallback = null;
        }

        function showModal(title, fields, callback) {
            document.getElementById('modal-title').innerText = title;
            const fieldsContainer = document.getElementById('modal-fields');
            fieldsContainer.innerHTML = '';
            fields.forEach(f => {
                const label = document.createElement('label');
                label.innerText = f.label;
                const inputContainer = document.createElement('div');
                inputContainer.className = 'emoji-picker-container';
                
                let input;
                if (f.type === 'textarea') {
                    input = document.createElement('textarea');
                } else {
                    input = document.createElement('input');
                }
                
                input.id = 'modal-input-' + f.id;
                input.value = f.value || '';
                input.placeholder = f.placeholder || '';
                
                const previewLabel = document.createElement('div');
                previewLabel.className = 'modal-preview-label';
                previewLabel.innerText = 'Preview';
                const preview = document.createElement('div');
                preview.className = 'modal-preview';
                preview.id = 'modal-preview-' + f.id;
                
                const updatePreview = () => {
                    preview.innerHTML = parseIcons(input.value);
                };
                input.oninput = updatePreview;
                updatePreview();
                
                const emojiBtn = document.createElement('span');
                emojiBtn.className = 'emoji-picker-btn';
                emojiBtn.innerText = '😀';
                emojiBtn.onclick = (e) => { e.stopPropagation(); toggleEmojiPicker(e, input.id); };
                
                inputContainer.appendChild(input);
                inputContainer.appendChild(emojiBtn);
                fieldsContainer.appendChild(label);
                fieldsContainer.appendChild(inputContainer);
                fieldsContainer.appendChild(previewLabel);
                fieldsContainer.appendChild(preview);
            });
            document.getElementById('modal-overlay').style.display = 'flex';
            currentModalCallback = (data) => {
                const result = {};
                fields.forEach(f => result[f.id] = document.getElementById('modal-input-' + f.id).value);
                callback(result);
                closeModal();
            };
        }

        function closeModal() { document.getElementById('modal-overlay').style.display = 'none'; }
        function saveModal() { if (currentModalCallback) currentModalCallback(); }

        let currentEmojiTab = 'emojis';
        function toggleEmojiPicker(e, inputId) {
            const btn = e.currentTarget;
            let picker = document.getElementById('emoji-picker');
            
            if (!picker) {
                picker = document.createElement('div');
                picker.id = 'emoji-picker';
                picker.className = 'emoji-picker';
                picker.innerHTML = '<div class="emoji-picker-tabs">' +
                        '<div class="emoji-picker-tab active" data-tab="emojis">Emojis</div>' +
                        '<div class="emoji-picker-tab" data-tab="icons">Icons</div>' +
                    '</div>' +
                    '<div class="emoji-picker-content">' +
                        '<div class="emoji-search"><input type="text" placeholder="Search..." id="emoji-search-input"></div>' +
                        '<div class="emoji-list" id="emoji-list"></div>' +
                    '</div>';
                document.body.appendChild(picker);
                
                const emojis = ['😀','😃','😄','😁','😆','😅','😂','🤣','😊','😇','🙂','🙃','😉','😌','😍','🥰','😘','😗','😙','😚','😋','😛','😝','😜','🤪','🤨','🧐','🤓','😎','🤩','🥳','😏','😒','😞','😔','😟','😕','🙁','☹️','😣','😖','😫','😩','🥺','😢','😭','😤','😠','😡','🤬','🤯','😳','🥵','🥶','😱','😨','😰','😥','😓','🤗','🤔','🤭','🤫','🤥','😶','😐','😑','😬','🙄','😯','😦','😧','😮','😲','🥱','😴','🤤','😪','😵','🤐','🥴','🤢','🤮','🤧','😷','🤒','🤕','🤑','🤠','😈','👿','👹','👺','🤡','👻','💀','☠️','👽','👾','🤖','🎃','😺','😸','😹','😻','😼','😽','🙀','😿','😾','🔥','✨','🚀','⭐','✅','❌','⚠️','💡','⚙️','📂','📄','📑','⚡','🐙','🦀','🐍','🟢','🌐','📊','🤖','☁️','☸️','🗄️','🧩'];
                const icons = ['terminal','git-commit','repo','package','code','beaker','bug','settings','search','folder','file','history','add','edit','trash','paintcan','star-full','check','error','warning','lightbulb','gear','github','rocket','zap','graph','database','cloud','extensions','symbol-method','symbol-function','symbol-variable','symbol-constant','symbol-property','symbol-field','symbol-class','symbol-interface','symbol-module','symbol-namespace','symbol-package','symbol-folder','symbol-file','symbol-enumerator','symbol-enum','symbol-keyword','symbol-color','symbol-unit','symbol-value','symbol-operator','symbol-type-parameter','symbol-snippet','symbol-text','symbol-ruler','symbol-event','symbol-key','symbol-null','symbol-boolean','symbol-number','symbol-string','symbol-array','symbol-object','symbol-parameter','symbol-reference','symbol-type','symbol-structure','symbol-union','symbol-type-alias','symbol-typedef','symbol-macro','symbol-label','symbol-enum-member'];
                
                const list = picker.querySelector('#emoji-list');
                const search = picker.querySelector('#emoji-search-input');
                const tabs = picker.querySelectorAll('.emoji-picker-tab');
                
                tabs.forEach(tab => {
                    tab.onclick = (ev) => {
                        ev.stopPropagation();
                        tabs.forEach(t => t.classList.remove('active'));
                        tab.classList.add('active');
                        currentEmojiTab = tab.dataset.tab;
                        renderContent(search.value);
                    };
                });

                const renderContent = (filter = '') => {
                    list.innerHTML = '';
                    const data = currentEmojiTab === 'emojis' ? emojis : icons;
                    const filtered = data.filter(item => item.toLowerCase().includes(filter.toLowerCase()));
                    
                    filtered.forEach(item => {
                        const el = document.createElement('div');
                        el.className = 'emoji-item';
                        if (currentEmojiTab === 'emojis') {
                            el.innerText = item;
                        } else {
                            el.innerHTML = '<i class="codicon codicon-' + item + '"></i>';
                            el.title = item;
                        }
                        
                        el.onclick = (ev) => {
                            ev.stopPropagation();
                            const target = document.getElementById(picker.dataset.targetId);
                            const start = target.selectionStart;
                            const end = target.selectionEnd;
                            const text = target.value;
                            const insert = currentEmojiTab === 'emojis' ? item : '$(' + item + ')';
                            target.value = text.substring(0, start) + insert + text.substring(end);
                            target.selectionStart = target.selectionEnd = start + insert.length;
                            target.focus();
                            target.dispatchEvent(new Event('input'));
                            picker.classList.remove('active');
                            setTimeout(() => { if (!picker.classList.contains('active')) picker.style.display = 'none'; }, 200);
                        };
                        list.appendChild(el);
                    });
                };
                
                search.oninput = (e) => renderContent(e.target.value);
                renderContent();
                
                document.addEventListener('mousedown', (e) => {
                    if (picker.classList.contains('active') && !picker.contains(e.target) && !e.target.classList.contains('emoji-picker-btn')) {
                        picker.classList.remove('active');
                        setTimeout(() => { if (!picker.classList.contains('active')) picker.style.display = 'none'; }, 200);
                    }
                });
            }
            
            picker.dataset.targetId = inputId;
            const isVisible = picker.classList.contains('active');
            
            if (isVisible) {
                picker.classList.remove('active');
                setTimeout(() => { if (!picker.classList.contains('active')) picker.style.display = 'none'; }, 200);
            } else {
                const rect = btn.getBoundingClientRect();
                
                if (window.innerHeight < 400) {
                    picker.classList.add('compact');
                } else {
                    picker.classList.remove('compact');
                }

                picker.style.display = 'flex';
                picker.offsetHeight; // force reflow
                picker.classList.add('active');
                
                picker.style.top = (rect.top - picker.offsetHeight - 5) + 'px';
                picker.style.left = (rect.right - picker.offsetWidth) + 'px';
                
                const pickerRect = picker.getBoundingClientRect();
                if (pickerRect.left < 0) picker.style.left = '5px';
                if (pickerRect.right > window.innerWidth) picker.style.left = (window.innerWidth - picker.offsetWidth - 5) + 'px';
                if (pickerRect.top < 0) picker.style.top = (rect.bottom + 5) + 'px';
                if (pickerRect.bottom > window.innerHeight) picker.style.top = (rect.top - picker.offsetHeight - 5) + 'px';
                
                const finalRect = picker.getBoundingClientRect();
                if (finalRect.bottom > window.innerHeight) {
                    picker.style.top = (window.innerHeight - picker.offsetHeight - 5) + 'px';
                }
                
                const searchInput = picker.querySelector('#emoji-search-input');
                searchInput.value = '';
                searchInput.dispatchEvent(new Event('input'));
                setTimeout(() => searchInput.focus(), 10);
            }
        }

window.addEventListener('resize', () => {
    const picker = document.getElementById('emoji-picker');
    if (picker && picker.classList.contains('active')) {
        picker.classList.remove('active');
        picker.style.display = 'none';
    }
});

function showContextMenu(x, y, id) {
    const menu = document.getElementById('context-menu');
    contextMenuItemId = id;
    menu.innerHTML = '<div class="context-menu-item" onclick="editItem(\\'' + id + '\\')">Modify</div>' +
        '<div class="context-menu-item" onclick="openColorPicker(\\'' + id + '\\')">Change Color</div>' +
            '<div class="context-menu-item" onclick="deleteItem(\\'' + id + '\\')">Delete</div>';
    menu.style.left = x + 'px';
    menu.style.top = y + 'px';
    menu.style.display = 'flex';
}

function openColorPicker(id) {
    colorPickerItemId = id;
    const item = items.find(i => i.id === id);
    const colorInput = document.getElementById('color-input');
    const colorPreview = document.getElementById('color-preview');
    const recursiveRow = document.getElementById('recursive-color-row');
    const recursiveCheck = document.getElementById('recursive-color-check');

    const currentColor = item?.color || '#ffffff';
    colorInput.value = currentColor.startsWith('#') ? currentColor : '#ffffff';
    colorPreview.style.backgroundColor = currentColor || 'transparent';
    colorInput.oninput = () => { colorPreview.style.backgroundColor = colorInput.value; };

    if (recursiveRow) recursiveRow.style.display = (item && item.type === 'folder') ? 'flex' : 'none';
    if (recursiveCheck) recursiveCheck.checked = false;

    document.getElementById('context-menu').style.display = 'none';
    document.getElementById('color-picker-overlay').style.display = 'flex';
}

function setPresetColor(color) {
    const colorInput = document.getElementById('color-input');
    const colorPreview = document.getElementById('color-preview');
    colorInput.value = color || '#ffffff';
    colorPreview.style.backgroundColor = color || 'transparent';
}

function applyColor() {
    const item = items.find(i => i.id === colorPickerItemId);
    if (item) {
        const colorInput = document.getElementById('color-input');
        const recursiveCheck = document.getElementById('recursive-color-check');
        const newColor = colorInput.value === '#ffffff' ? '' : colorInput.value;

        item.color = newColor;

        if (item.type === 'folder' && recursiveCheck && recursiveCheck.checked) {
            applyColorRecursively(item.id, newColor);
        }

        save(); render();
    }
    closeColorPicker();
}

function applyColorRecursively(parentId, color) {
    items.forEach(i => {
        if (i.parentId === parentId) {
            i.color = color;
            if (i.type === 'folder') {
                applyColorRecursively(i.id, color);
            }
        }
    });
}

function closeColorPicker() {
    document.getElementById('color-picker-overlay').style.display = 'none';
    colorPickerItemId = null;
}

function openSettings() {
    const overlay = document.getElementById('settings-overlay');
    if (overlay.style.display === 'flex') {
        closeSettings();
    } else {
        overlay.style.display = 'flex';
        switchSettingsTab('display');
        updateSettingsUI();
    }
}

function switchSettingsTab(tab) {
    document.querySelectorAll('.settings-tab').forEach(t => t.classList.remove('active'));
    document.querySelectorAll('.settings-content').forEach(c => c.classList.remove('active'));

    document.getElementById('tab-' + tab).classList.add('active');
    document.getElementById('settings-' + tab).classList.add('active');
}

function closeSettings() {
    document.getElementById('settings-overlay').style.display = 'none';
}

function updateHistoryLimits() {
    settings.commandHistoryLimit = parseInt(document.getElementById('cmd-limit-input').value) || 20;
    settings.clipboardHistoryLimit = parseInt(document.getElementById('clip-limit-input').value) || 20;
    vscode.postMessage({ type: 'saveSettings', settings });
}


let activeHistoryTab = 'commands';
function switchHistoryTab(tab) {
    activeHistoryTab = tab;
    render();
}

function renderHistoryView(container) {
    container.innerHTML = \`
                <div class="history-view-container">
                    <div class="history-tabs">
                        <div class="history-tab \${activeHistoryTab === 'commands' ? 'active' : ''}" onclick="switchHistoryTab('commands')">Commands</div>
                        <div class="history-tab \${activeHistoryTab === 'clipboard' ? 'active' : ''}" onclick="switchHistoryTab('clipboard')">Clipboard</div>
                    </div>
                    <div id="hist-commands" class="history-list \${activeHistoryTab === 'commands' ? 'active' : ''}"></div>
                    <div id="hist-clipboard" class="history-list \${activeHistoryTab === 'clipboard' ? 'active' : ''}"></div>
                </div>
            \`;
            
            const cmdList = container.querySelector('#hist-commands');
            const clipList = container.querySelector('#hist-clipboard');

            cmdList.innerHTML = commandHistory.length ? '' : '<div style="opacity: 0.5; padding: 10px; text-align: center; font-size: 11px;">No command history</div>';
            commandHistory.forEach(cmd => {
                const el = document.createElement('div');
                el.className = 'history-item';
                if (settings.executionMode === 'locked') el.style.opacity = '0.6';
                
                const textEl = document.createElement('span');
                textEl.className = 'history-item-text';
                textEl.textContent = cmd;
                textEl.title = cmd;
                el.appendChild(textEl);

                // Copy button
                const copyBtn = document.createElement('button');
                copyBtn.className = 'history-copy-btn';
                copyBtn.innerHTML = '📋';
                copyBtn.title = 'Copy to clipboard';
                copyBtn.onclick = (e) => {
                    e.stopPropagation();
                    navigator.clipboard.writeText(cmd);
                    copyBtn.innerHTML = '✓';
                    setTimeout(() => { copyBtn.innerHTML = '📋'; }, 1000);
                };
                el.appendChild(copyBtn);

                el.onclick = () => {
                    if (settings.executionMode === 'locked') {
                        vscode.postMessage({ type: 'showInfo', message: 'Execution is locked 🔒' });
                        return;
                    }
                    vscode.postMessage({ type: 'executeCommand', command: cmd });
                };
                cmdList.appendChild(el);
            });

            clipList.innerHTML = clipboardHistory.length ? '' : '<div style="opacity: 0.5; padding: 10px; text-align: center; font-size: 11px;">No clipboard history</div>';
            clipboardHistory.forEach(text => {
                const el = document.createElement('div');
                el.className = 'history-item';
                
                const textEl = document.createElement('span');
                textEl.className = 'history-item-text';
                textEl.textContent = text.substring(0, 100) + (text.length > 100 ? '...' : '');
                textEl.title = text;
                el.appendChild(textEl);

                const actionsEl = document.createElement('div');
                actionsEl.className = 'history-item-actions';
                
                const insertBtn = document.createElement('button');
                insertBtn.className = 'history-action-btn' + (settings.executionMode === 'locked' ? ' disabled' : '');
                insertBtn.innerHTML = '📥';
                insertBtn.title = 'Insert into ' + (settings.executionMode === 'editor' ? 'Editor' : 'Terminal');
                insertBtn.onclick = (e) => {
                    e.stopPropagation();
                    if (settings.executionMode === 'locked') {
                        vscode.postMessage({ type: 'showInfo', message: 'Execution is locked 🔒' });
                        return;
                    }
                    vscode.postMessage({ type: 'executeCommand', command: text });
                };
                actionsEl.appendChild(insertBtn);
                el.appendChild(actionsEl);

                el.onclick = () => {
                    navigator.clipboard.writeText(text);
                    el.classList.add('copied');
                    const original = textEl.textContent;
                    textEl.textContent = '✓ Copied!';
                    setTimeout(() => {
                        textEl.textContent = original;
                        el.classList.remove('copied');
                    }, 1000);
                };
                clipList.appendChild(el);
            });
        }

        function renderHistory() {
            if (activeTabId === 'history') {
                render();
            }
        }

        function toggleReloadButton() {
            settings.showReloadButton = !settings.showReloadButton;
            vscode.postMessage({ type: 'saveSettings', settings });
        }

        function toggleConfirmDelete() {
            settings.confirmDelete = !settings.confirmDelete;
            vscode.postMessage({ type: 'saveSettings', settings });
        }

        function toggleVersionChecker() {
            settings.showVersionChecker = !settings.showVersionChecker;
            vscode.postMessage({ type: 'saveSettings', settings });
        }

        function toggleGithubButton() {
            settings.showGithubButton = !settings.showGithubButton;
            vscode.postMessage({ type: 'saveSettings', settings });
        }

        let versionData = { localVersion: null, remoteVersion: null, repoUrl: null, projectName: null };

        function checkVersion() {
            document.getElementById('version-overlay').style.display = 'flex';
            document.getElementById('version-loading').style.display = 'block';
            document.getElementById('version-content').style.display = 'none';
            vscode.postMessage({ type: 'checkVersion' });
        }

        function displayVersionInfo(data) {
            versionData = data;
            document.getElementById('version-loading').style.display = 'none';
            document.getElementById('version-content').style.display = 'block';
            
            document.getElementById('version-project').textContent = data.projectName || 'Unknown Project';
            document.getElementById('version-local').textContent = data.localVersion || 'N/A';
            document.getElementById('version-remote').textContent = data.remoteVersion || 'N/A';
            document.getElementById('version-repo').textContent = data.repoUrl || 'No GitHub repository detected';
            
            // Compare versions and show status
            const statusEl = document.getElementById('version-status');
            const localBoxes = document.querySelectorAll('.version-box');
            localBoxes.forEach(b => b.classList.remove('outdated', 'current'));
            
            if (data.localVersion && data.remoteVersion) {
                const comparison = compareVersions(data.localVersion, data.remoteVersion);
                if (comparison < 0) {
                    statusEl.textContent = '⬆️';
                    statusEl.title = 'Update available';
                    localBoxes[0].classList.add('outdated');
                } else if (comparison > 0) {
                    statusEl.textContent = '⬇️';
                    statusEl.title = 'Local is ahead';
                    localBoxes[0].classList.add('current');
                } else {
                    statusEl.textContent = '✅';
                    statusEl.title = 'Up to date';
                    localBoxes[0].classList.add('current');
                }
            } else {
                statusEl.textContent = '⟷';
                statusEl.title = 'Cannot compare';
            }
        }

        function compareVersions(v1, v2) {
            const parts1 = v1.replace(/^v/, '').split('.').map(n => parseInt(n) || 0);
            const parts2 = v2.replace(/^v/, '').split('.').map(n => parseInt(n) || 0);
            for (let i = 0; i < Math.max(parts1.length, parts2.length); i++) {
                const p1 = parts1[i] || 0;
                const p2 = parts2[i] || 0;
                if (p1 < p2) return -1;
                if (p1 > p2) return 1;
            }
            return 0;
        }

        function copyVersion(type) {
            const version = type === 'local' ? versionData.localVersion : versionData.remoteVersion;
            if (version) {
                navigator.clipboard.writeText(version);
                const el = document.getElementById('version-' + type);
                const original = el.textContent;
                el.textContent = '✓ Copied!';
                setTimeout(() => { el.textContent = original; }, 1000);
            }
        }

        function closeVersionModal() {
            document.getElementById('version-overlay').style.display = 'none';
        }

        function exportConfig() { vscode.postMessage({ type: 'exportConfig' }); }
        function importConfig() { vscode.postMessage({ type: 'importConfig' }); }
        function selectConfigPath() { vscode.postMessage({ type: 'selectConfigPath' }); }
        function reloadExtensions() { vscode.postMessage({ type: 'reloadExtensions' }); }
        function cdToActiveFile() { vscode.postMessage({ type: 'cdToActiveFile' }); }

        // GitHub Downloader logic
        function openGithubModal() {
            document.getElementById('github-overlay').style.display = 'flex';
            const searchInput = document.getElementById('github-search-user');
            if (settings.githubUsername) {
                searchInput.value = settings.githubUsername;
            }
        }

        function closeGithubModal() {
            document.getElementById('github-overlay').style.display = 'none';
        }

        function updateGithubUsername(val) {
            settings.githubUsername = val;
            vscode.postMessage({ type: 'saveSettings', settings });
        }

        function fetchRepos() {
            const username = document.getElementById('github-search-user').value.trim();
            if (!username) return;
            
            const status = document.getElementById('github-status');
            const list = document.getElementById('repo-list');
            
            status.textContent = 'Fetching repositories...';
            list.innerHTML = '<div style="padding: 20px; text-align: center; opacity: 0.5;">Loading...</div>';
            
            vscode.postMessage({ type: 'fetchGithubRepos', username });
        }

        function displayGithubRepos(repos) {
            const status = document.getElementById('github-status');
            const list = document.getElementById('repo-list');
            
            status.textContent = 'Found ' + repos.length + ' repositories';
            list.innerHTML = '';
            
            if (repos.length === 0) {
                list.innerHTML = '<div style="padding: 20px; text-align: center; opacity: 0.5;">No public repositories found</div>';
                return;
            }
            
            repos.forEach(repo => {
                const el = document.createElement('div');
                el.className = 'repo-item';
                el.innerHTML = \`
                    <div class="repo-name">📦 \${repo.name}</div>
                    \${repo.description ? \`<div class="repo-desc">\${repo.description}</div>\` : ''}
                    <div class="repo-meta">
                        <span>⭐ \${repo.stars}</span>
                        \${repo.language ? \`<span>🔹 \${repo.language}</span>\` : ''}
                        <span>📅 \${new Date(repo.updatedAt).toLocaleDateString()}</span>
                    </div>
                \`;
                el.onclick = () => {
                    vscode.postMessage({ type: 'cloneRepo', cloneUrl: repo.cloneUrl, name: repo.name });
                    closeGithubModal();
                };
                list.appendChild(el);
            });
        }

        function displayGithubError(error) {
            const status = document.getElementById('github-status');
            const list = document.getElementById('repo-list');
            status.textContent = 'Error: ' + error;
            list.innerHTML = '<div style="padding: 20px; text-align: center; color: var(--vscode-errorForeground);">Failed to load repositories</div>';
        }

        document.addEventListener('click', () => {
            document.getElementById('context-menu').style.display = 'none';
            const picker = document.getElementById('emoji-picker');
            if (picker) picker.style.display = 'none';
        });

        // Signal that webview is ready to receive data\r\n        vscode.postMessage({ type: 'ready' });

        // Search functionality
        function toggleSearch() {
            searchMode = !searchMode;
            const container = document.getElementById('search-container');
            const searchBtn = document.getElementById('search-btn');
            const input = document.getElementById('search-input');
            
            container.classList.toggle('active', searchMode);
            if (searchBtn) searchBtn.classList.toggle('primary', searchMode);
            
            if (searchMode) {
                input.focus();
            } else {
                input.value = '';
                render();
            }
        }

        function performSearch() {
            const input = document.getElementById('search-input');
            const clearBtn = document.getElementById('search-clear-btn');
            const query = input.value.toLowerCase().trim();
            const content = document.getElementById('content');
            
            if (clearBtn) clearBtn.style.display = query ? 'block' : 'none';
            
            if (!query) {
                render();
                return;
            }
            
            const results = items.filter(i => {
                if (i.type === 'separator') return false;
                const nameMatch = i.name && i.name.toLowerCase().includes(query);
                const cmdMatch = i.command && i.command.toLowerCase().includes(query);
                const descMatch = i.description && i.description.toLowerCase().includes(query);
                return nameMatch || cmdMatch || descMatch;
            });
            
            content.innerHTML = '';
            
            if (results.length === 0) {
                content.innerHTML = '<div style="opacity: 0.5; padding: 20px; text-align: center;">No results found</div>';
                return;
            }
            
            results.forEach(item => {
                const el = document.createElement('div');
                el.className = 'search-result';
                if (item.color) {
                    el.style.borderLeftColor = item.color;
                    el.style.color = item.color;
                }
                
                el.onmouseenter = (e) => TooltipManager.show(e, item);
                el.onmousemove = (e) => TooltipManager.move(e);
                el.onmouseleave = () => TooltipManager.hide();
                
                const icon = item.type === 'tab' ? '📑' : item.type === 'folder' ? '📁' : '📄';
                const path = getItemPath(item);
                const highlightedName = highlightMatch(item.name, query);
                
                el.innerHTML = '<span>' + icon + '</span>' +
                    '<span class="snippet-name">' + parseIcons(highlightedName) + '</span>' +
                    (path ? '<span class="search-result-path">' + path + '</span>' : '');
                
                el.onclick = () => navigateToItem(item);
                content.appendChild(el);
            });
        }

        function clearSearch() {
            const input = document.getElementById('search-input');
            if (input) {
                input.value = '';
                performSearch();
                input.focus();
            }
        }

        function highlightMatch(text, query) {
            if (!text) return '';
            const idx = text.toLowerCase().indexOf(query);
            if (idx === -1) return text;
            return text.substring(0, idx) + 
                '<span class="search-highlight">' + text.substring(idx, idx + query.length) + '</span>' +
                text.substring(idx + query.length);
        }

        function getItemPath(item) {
            const parts = [];
            let current = item;
            const visited = new Set();
            while (current.parentId) {
                if (visited.has(current.id)) break;
                visited.add(current.id);
                
                const parent = items.find(i => i.id === current.parentId);
                if (parent) {
                    parts.unshift(parent.name);
                    current = parent;
                } else break;
            }
            return parts.join(' › ');
        }

        function navigateToItem(item) {
            searchMode = false;
            document.getElementById('search-container').classList.remove('active');
            document.getElementById('search-btn').classList.remove('primary');
            document.getElementById('search-input').value = '';
            
            if (item.type === 'tab') {
                activeTabId = item.id;
            } else if (item.parentId) {
                // Find the root tab
                let parent = items.find(i => i.id === item.parentId);
                const visited = new Set();
                while (parent && parent.type !== 'tab') {
                    if (visited.has(parent.id)) break;
                    visited.add(parent.id);
                    
                    if (parent.type === 'folder') parent.expanded = true;
                    parent = items.find(i => i.id === parent.parentId);
                }
                if (parent && parent.type === 'tab') {
                    activeTabId = parent.id;
                } else {
                    activeTabId = 'root';
                }
                // Expand any parent folders
                let p = items.find(i => i.id === item.parentId);
                const visited2 = new Set();
                while (p) {
                    if (visited2.has(p.id)) break;
                    visited2.add(p.id);
                    
                    if (p.type === 'folder') p.expanded = true;
                    p = items.find(i => i.id === p.parentId);
                }
            } else {
                activeTabId = 'root';
            }
            
            render();
            save();
            
            // Execute snippet if it's a snippet
            if (item.type === 'snippet' && item.command) {
                vscode.postMessage({ type: 'executeCommand', command: item.command });
            }
        }

        function handleSearchKeydown(e) {
            if (e.key === 'Escape') {
                toggleSearch();
            }
        }

        const TooltipManager = {
            el: null,
            init() {
                this.el = document.getElementById('rich-tooltip');
            },
            show(e, item) {
                if (!settings.enableRichTooltips) return;
                if (!this.el) this.init();
                if (!item.description && !item.command) return;

                let html = '';
                if (item.description) {
                    html += '<div class="tooltip-section">' +
                        '<div class="tooltip-label">Description</div>' +
                        '<div class="tooltip-value">' + item.description + '</div>' +
                    '</div>';
                }
                if (item.command) {
                    html += '<div class="tooltip-section">' +
                        '<div class="tooltip-label">Command</div>' +
                        '<div class="tooltip-value tooltip-command">' + item.command + '</div>' +
                    '</div>';
                }

                this.el.innerHTML = html;
                this.el.style.display = 'block';
                this.move(e);
            },
            move(e) {
                if (!this.el) return;
                const x = e.clientX + 15;
                const y = e.clientY + 15;

                // Keep inside viewport
                const rect = this.el.getBoundingClientRect();
                const maxX = window.innerWidth - rect.width - 20;
                const maxY = window.innerHeight - rect.height - 20;

                this.el.style.left = Math.min(x, maxX) + 'px';
                this.el.style.top = Math.min(y, maxY) + 'px';
            },
            hide() {
                if (this.el) this.el.style.display = 'none';
            }
        };

// Responsive toolbar - switch to horizontal when not enough vertical space
        function checkToolbarLayout() {
            const sidebar = document.querySelector('.sidebar');
            if (!sidebar) return;

            const buttons = sidebar.querySelectorAll('.side-btn');
            const visibleButtons = Array.from(buttons).filter(btn => btn.style.display !== 'none');
            const buttonHeight = 44; // button height + gap
            const minRequiredHeight = visibleButtons.length * buttonHeight + 20; // padding

            if (window.innerHeight < minRequiredHeight) {
                document.body.classList.add('horizontal-toolbar');
            } else {
                document.body.classList.remove('horizontal-toolbar');
            }
        }

// Check on load and resize
window.addEventListener('resize', checkToolbarLayout);
checkToolbarLayout();
</script>
    </body>
    </html>`;
    }
}

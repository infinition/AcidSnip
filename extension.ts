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
        })
    );
}

class SnippetViewProvider implements vscode.WebviewViewProvider {
    public static readonly viewType = 'fastSnippetExplorer';
    private _view?: vscode.WebviewView;

    constructor(
        private readonly _extensionUri: vscode.Uri,
        private readonly _context: vscode.ExtensionContext
    ) { }

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
                            const defaultSettings: Settings = { showReloadButton: false, configFilePath: '', confirmDelete: false, showVersionChecker: false, githubUsername: '', showGithubButton: true };
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
        const defaultSettings: Settings = { showReloadButton: false, configFilePath: '', confirmDelete: false, showVersionChecker: false, githubUsername: '', showGithubButton: true };
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

        const terminal = vscode.window.activeTerminal || vscode.window.createTerminal('AcidSnip');
        terminal.show();
        terminal.sendText(finalCmd);
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
    <title>AcidSnip</title>
    <style>
        body {
            font-family: var(--vscode-font-family);
            color: var(--vscode-foreground);
            background-color: var(--vscode-editor-background);
            padding: 0; margin: 0; display: flex; flex-direction: row; height: 100vh; overflow: hidden;
        }
        .tabs-container {
            display: flex; overflow-x: auto; overflow-y: hidden;
            background-color: var(--vscode-sideBarSectionHeader-background);
            border-bottom: 1px solid var(--vscode-sideBarSectionHeader-border);
            padding: 0 5px; align-items: center; height: 38px; flex-shrink: 0; white-space: nowrap; scrollbar-width: none;
        }
        .tabs-container::-webkit-scrollbar { display: none; }
        .tab {
            padding: 5px 10px; cursor: pointer; opacity: 0.7; border-bottom: 2px solid transparent; font-size: 12px;
            user-select: none; display: flex; align-items: center; gap: 5px;
        }
        .tab:hover { opacity: 1; background-color: var(--vscode-list-hoverBackground); }
        .tab.active { opacity: 1; border-bottom-color: var(--vscode-activityBarBadge-background); font-weight: bold; }
        .main-container { flex: 1; display: flex; flex-direction: column; min-width: 0; height: 100vh; }
        .content { flex: 1; overflow-y: auto; padding: 10px; }
        .sidebar {
            width: 44px; background-color: var(--vscode-sideBar-background);
            border-left: 1px solid var(--vscode-sideBar-border);
            display: flex; flex-direction: column; align-items: center; padding: 10px 0; gap: 12px; flex-shrink: 0;
            transition: all 0.2s ease;
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
        .modal input, .modal textarea { width: 100%; background: var(--vscode-input-background); color: var(--vscode-input-foreground); border: 1px solid var(--vscode-input-border); padding: 5px; margin-bottom: 10px; border-radius: 2px; box-sizing: border-box; font-family: inherit; }
        .modal input[type="color"] { width: 50px; height: 30px; padding: 0; border: none; cursor: pointer; }
        .modal textarea { height: 60px; resize: vertical; }
        .modal-buttons { display: flex; justify-content: flex-end; gap: 10px; }
        .modal-btn { padding: 4px 12px; cursor: pointer; border-radius: 2px; border: none; background: var(--vscode-button-background); color: var(--vscode-button-foreground); }
        .modal-btn.secondary { background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); }
        .emoji-picker-container { position: relative; margin-bottom: 10px; }
        .emoji-picker-btn { cursor: pointer; font-size: 18px; padding: 2px; }
        .emoji-picker { position: absolute; bottom: 30px; left: 0; background: var(--vscode-editorWidget-background); border: 1px solid var(--vscode-widget-border); border-radius: 4px; display: none; flex-direction: column; width: 200px; height: 250px; z-index: 110; box-shadow: 0 4px 10px rgba(0,0,0,0.5); }
        .emoji-search { padding: 5px; border-bottom: 1px solid var(--vscode-widget-border); }
        .emoji-list { flex: 1; overflow-y: auto; display: grid; grid-template-columns: repeat(5, 1fr); padding: 5px; gap: 5px; }
        .emoji-item { cursor: pointer; text-align: center; font-size: 20px; padding: 2px; border-radius: 4px; }
        .emoji-item:hover { background: var(--vscode-list-hoverBackground); }
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
        .search-container { padding: 8px 10px; border-bottom: 1px solid var(--vscode-widget-border); display: none; }
        .search-container.active { display: block; }
        .search-input { width: 100%; padding: 6px 10px; background: var(--vscode-input-background); color: var(--vscode-input-foreground); border: 1px solid var(--vscode-input-border); border-radius: 4px; font-size: 12px; box-sizing: border-box; }
        .search-input:focus { outline: none; border-color: var(--vscode-focusBorder); }
        .search-result { padding: 6px 10px; margin: 4px 0; border-radius: 4px; background: var(--vscode-list-inactiveSelectionBackground); cursor: pointer; display: flex; align-items: center; gap: 8px; }
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
    </style>
</head>
<body>
    <div class="main-container">
        <div class="tabs-container" id="tabs-container"></div>
        <div class="search-container" id="search-container">
            <input type="text" class="search-input" id="search-input" placeholder="🔍 Search snippets, folders, tabs..." oninput="performSearch()" onkeydown="handleSearchKeydown(event)">
        </div>
        <div class="content" id="content"></div>
    </div>
    <div class="sidebar">
        <button class="side-btn primary" onclick="addSnippet()" title="Add Snippet">📄</button>
        <button class="side-btn" onclick="addSmartSnippet()" title="Add Smart Snippet">⚡</button>
        <button class="side-btn" onclick="addFolder()" title="Add Folder">📂</button>
        <button class="side-btn" onclick="addTab()" title="Add Tab">📑</button>
        <button class="side-btn" onclick="addSeparator()" title="Add Separator">➖</button>
        <button class="side-btn" onclick="toggleSearch()" title="Search" id="search-btn">🔍</button>
        <div class="side-spacer"></div>
        <button class="side-btn" onclick="cdToActiveFile()" title="CD to Explorer Selection">📂</button>
        <button class="side-btn" id="reload-btn" onclick="reloadExtensions()" title="Reload Extensions" style="display: none;">🔄</button>
        <button class="side-btn" id="version-btn" onclick="checkVersion()" title="Check Version" style="display: none;">📦</button>
        <button class="side-btn" id="github-btn" onclick="openGithubModal()" title="Download GitHub Repos">🐙</button>
        <button class="side-btn" onclick="openSettings()" title="Settings">⚙️</button>
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
    <div class="modal-overlay" id="settings-overlay">
        <div class="modal" style="max-width: 350px;">
            <h3>⚙️ Settings</h3>
            <div class="settings-section">
                <h4>Display</h4>
                <div class="toggle-row">
                    <span>Show Reload Button</span>
                    <div class="toggle-switch" id="toggle-reload" onclick="toggleReloadButton()"></div>
                </div>
                <div class="toggle-row">
                    <span>Confirm before delete</span>
                    <div class="toggle-switch" id="toggle-confirm-delete" onclick="toggleConfirmDelete()"></div>
                </div>
                <div class="toggle-row">
                    <span>Show GitHub Button</span>
                    <div class="toggle-switch" id="toggle-github" onclick="toggleGithubButton()"></div>
                </div>
                <div style="margin-top: 10px;">
                    <label>Default GitHub Username</label>
                    <input type="text" id="github-username-input" placeholder="e.g. microsoft" onchange="updateGithubUsername(this.value)">
                </div>
                <div class="toggle-row">
                    <span>Show Version Checker</span>
                    <div class="toggle-switch" id="toggle-version-checker" onclick="toggleVersionChecker()"></div>
                </div>
            </div>
            <div class="settings-section">
                <h4>Configuration</h4>
                <button class="modal-btn" onclick="exportConfig()" style="width: 100%; margin-bottom: 8px;">📤 Export Config</button>
                <button class="modal-btn secondary" onclick="importConfig()" style="width: 100%; margin-bottom: 8px;">📥 Import Config</button>
                <button class="modal-btn secondary" onclick="selectConfigPath()" style="width: 100%;">📁 Select Config File</button>
                <div class="path-display" id="config-path-display">No config file selected</div>
            </div>
            <div class="modal-buttons" style="margin-top: 15px;">
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
    <script>
        const vscode = acquireVsCodeApi();
        let items = [];
        let activeTabId = null;
        let currentModalCallback = null;
        let contextMenuItemId = null;
        let colorPickerItemId = null;
        let confirmCallback = null;
        let searchMode = false;
        let settings = { showReloadButton: false, configFilePath: '', confirmDelete: false, showVersionChecker: false };

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
                    } else if (activeTabId !== 'root' && !items.some(i => i.id === activeTabId)) {
                        activeTabId = hasRootItems ? 'root' : (items.find(i => i.type === 'tab')?.id || null);
                    }
                    render();
                    break;
                case 'loadSettings':
                    settings = message.settings || { showReloadButton: false, configFilePath: '', confirmDelete: false, showVersionChecker: false };
                    updateSettingsUI();
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
            const pathDisplay = document.getElementById('config-path-display');
            
            if (reloadBtn) reloadBtn.style.display = settings.showReloadButton ? 'flex' : 'none';
            if (versionBtn) versionBtn.style.display = settings.showVersionChecker ? 'flex' : 'none';
            if (toggleReload) toggleReload.classList.toggle('active', settings.showReloadButton);
            if (toggleConfirmDelete) toggleConfirmDelete.classList.toggle('active', settings.confirmDelete);
            if (toggleVersionChecker) toggleVersionChecker.classList.toggle('active', settings.showVersionChecker);
            if (pathDisplay) pathDisplay.textContent = settings.configFilePath || 'No config file selected';
            
            const githubBtn = document.getElementById('github-btn');
            const toggleGithub = document.getElementById('toggle-github');
            if (githubBtn) githubBtn.style.display = settings.showGithubButton ? 'flex' : 'none';
            if (toggleGithub) toggleGithub.classList.toggle('active', settings.showGithubButton);
            
            const githubInput = document.getElementById('github-username-input');
            if (githubInput) githubInput.value = settings.githubUsername || '';
            
            checkToolbarLayout();
        }

        function save() { vscode.postMessage({ type: 'saveItems', items }); }

        function render() {
            const tabsContainer = document.getElementById('tabs-container');
            const content = document.getElementById('content');
            tabsContainer.innerHTML = '';
            content.innerHTML = '';

            const tabs = items.filter(i => i.type === 'tab');
            const hasRootItems = items.some(i => isRootItem(i) && i.type !== 'tab');
            if (hasRootItems) {
                tabs.unshift({ id: 'root', name: '🏠', type: 'tab' });
            }

            tabs.forEach(tab => {
                const el = document.createElement('div');
                el.className = 'tab' + (tab.id === activeTabId ? ' active' : '');
                el.innerHTML = tab.name;
                
                if (tab.color) {
                    el.style.color = tab.color;
                    el.style.opacity = '1';
                }
                if (tab.id === activeTabId) {
                    el.style.borderBottomColor = tab.color || 'var(--vscode-activityBarBadge-background)';
                }

                el.onclick = () => { activeTabId = tab.id; render(); };
                el.draggable = true;
                el.ondragstart = (e) => { e.dataTransfer.setData('text/plain', tab.id); el.classList.add('dragging'); };
                el.ondragend = () => el.classList.remove('dragging');
                el.ondragover = (e) => { e.preventDefault(); el.classList.add('drag-over'); };
                el.ondragleave = () => el.classList.remove('drag-over');
                el.ondrop = (e) => {
                    e.preventDefault(); el.classList.remove('drag-over');
                    const draggedId = e.dataTransfer.getData('text/plain');
                    const draggedItem = items.find(i => i.id === draggedId);
                    if (!draggedItem) return;
                    if (draggedItem.type === 'tab') {
                        const fromIdx = items.indexOf(draggedItem);
                        const toIdx = items.indexOf(tab);
                        items.splice(fromIdx, 1);
                        items.splice(toIdx, 0, draggedItem);
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

            renderItems(activeTabId === 'root' ? undefined : activeTabId, content);
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
                        '<div class="snippet-name">📁 ' + item.name + '</div>' +
                        '<div class="actions">' +
                            '<button class="action-btn" onclick="event.stopPropagation(); editItem(\\'' + item.id + '\\')">✎</button>' +
                            '<button class="action-btn" onclick="event.stopPropagation(); deleteItem(\\'' + item.id + '\\')">🗑</button>' +
                        '</div>';
                    
                    header.onclick = (e) => {
                        item.expanded = !item.expanded;
                        folderEl.classList.toggle('expanded');
                        save();
                    };

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
                    if (item.description) el.title = item.description;
                    
                    el.style.borderLeftColor = item.color || 'transparent';
                    el.style.color = item.color || 'inherit';
                    const isSmart = item.command && item.command.includes('{{arg$');
                    
                    el.innerHTML = '<div class="drag-handle" draggable="true">⠿</div>' +
                        '<div class="snippet-name">' + item.name + (isSmart ? '<span class="smart-badge" title="Smart Snippet">⚡</span>' : '') + '</div>' +
                        '<div class="snippet-command">' + (item.command || '') + '</div>' +
                        '<div class="actions">' +
                            '<button class="action-btn" onclick="event.stopPropagation(); editItem(\\'' + item.id + '\\')">✎</button>' +
                            '<button class="action-btn" onclick="event.stopPropagation(); deleteItem(\\'' + item.id + '\\')">🗑</button>' +
                        '</div>';
                    
                    el.onclick = () => vscode.postMessage({ type: 'executeCommand', command: item.command });
                    setupDragDrop(el, item);
                    container.appendChild(el);
                }
            });
        }

        function setupDragDrop(el, item) {
            const handle = el.querySelector('.drag-handle') || el;
            handle.draggable = true;
            handle.ondragstart = (e) => {
                e.dataTransfer.setData('text/plain', item.id);
                el.classList.add('dragging');
                e.stopPropagation();
            };
            handle.ondragend = () => el.classList.remove('dragging');

            el.ondragover = (e) => { e.preventDefault(); e.stopPropagation(); el.classList.add('drag-over'); };
            el.ondragleave = () => el.classList.remove('drag-over');
            el.ondrop = (e) => {
                e.preventDefault(); e.stopPropagation(); el.classList.remove('drag-over');
                const draggedId = e.dataTransfer.getData('text/plain');
                const draggedItem = items.find(i => i.id === draggedId);
                if (!draggedItem || draggedItem.id === item.id) return;

                if (item.type === 'folder') {
                    draggedItem.parentId = item.id;
                    item.expanded = true;
                } else {
                    draggedItem.parentId = item.parentId;
                    const fromIdx = items.indexOf(draggedItem);
                    const toIdx = items.indexOf(item);
                    items.splice(fromIdx, 1);
                    items.splice(toIdx, 0, draggedItem);
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
            if (activeTabId === id) activeTabId = items.find(i => i.type === 'tab')?.id || null;
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
                
                const emojiBtn = document.createElement('span');
                emojiBtn.className = 'emoji-picker-btn';
                emojiBtn.innerText = '😀';
                emojiBtn.onclick = () => toggleEmojiPicker(input.id);
                
                inputContainer.appendChild(input);
                inputContainer.appendChild(emojiBtn);
                fieldsContainer.appendChild(label);
                fieldsContainer.appendChild(inputContainer);
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

        function toggleEmojiPicker(inputId) {
            let picker = document.getElementById('emoji-picker');
            if (!picker) {
                picker = document.createElement('div');
                picker.id = 'emoji-picker';
                picker.className = 'emoji-picker';
                picker.innerHTML = '<div class="emoji-search"><input type="text" placeholder="Search..." id="emoji-search-input"></div><div class="emoji-list" id="emoji-list"></div>';
                document.body.appendChild(picker);
                const emojis = ['😀','😃','😄','😁','😆','😅','😂','🤣','😊','😇','🙂','🙃','😉','😌','😍','🥰','😘','😗','😙','😚','😋','😛','😝','😜','🤪','🤨','🧐','🤓','😎','🤩','🥳','😏','😒','😞','😔','😟','😕','🙁','☹️','😣','😖','😫','😩','🥺','😢','😭','😤','😠','😡','🤬','🤯','😳','🥵','🥶','😱','😨','😰','😥','😓','🤗','🤔','🤭','🤫','🤥','😶','😐','😑','😬','🙄','😯','😦','😧','😮','😲','🥱','😴','🤤','😪','😵','🤐','🥴','🤢','🤮','🤧','😷','🤒','🤕','🤑','🤠','😈','👿','👹','👺','🤡','👻','💀','☠️','👽','👾','🤖','🎃','😺','😸','😹','😻','😼','😽','🙀','😿','😾'];
                const list = picker.querySelector('#emoji-list');
                const search = picker.querySelector('#emoji-search-input');
                const renderEmojis = (filter = '') => {
                    list.innerHTML = '';
                    emojis.filter(e => e.includes(filter)).forEach(e => {
                        const item = document.createElement('div');
                        item.className = 'emoji-item';
                        item.innerText = e;
                        item.onclick = () => { document.getElementById(picker.dataset.targetId).value += e; picker.style.display = 'none'; };
                        list.appendChild(item);
                    });
                };
                search.oninput = (e) => renderEmojis(e.target.value);
                renderEmojis();
            }
            picker.dataset.targetId = inputId;
            picker.style.display = picker.style.display === 'flex' ? 'none' : 'flex';
            if (picker.style.display === 'flex') picker.querySelector('#emoji-search-input').focus();
        }

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
            const currentColor = item?.color || '#ffffff';
            colorInput.value = currentColor.startsWith('#') ? currentColor : '#ffffff';
            colorPreview.style.backgroundColor = currentColor || 'transparent';
            colorInput.oninput = () => { colorPreview.style.backgroundColor = colorInput.value; };
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
                item.color = colorInput.value === '#ffffff' ? '' : colorInput.value;
                save(); render();
            }
            closeColorPicker();
        }

        function closeColorPicker() {
            document.getElementById('color-picker-overlay').style.display = 'none';
            colorPickerItemId = null;
        }

        function openSettings() {
            document.getElementById('settings-overlay').style.display = 'flex';
            updateSettingsUI();
        }

        function closeSettings() {
            document.getElementById('settings-overlay').style.display = 'none';
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
            const query = document.getElementById('search-input').value.toLowerCase().trim();
            const content = document.getElementById('content');
            
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
                
                const icon = item.type === 'tab' ? '📑' : item.type === 'folder' ? '📁' : '📄';
                const path = getItemPath(item);
                const highlightedName = highlightMatch(item.name, query);
                
                el.innerHTML = '<span>' + icon + '</span>' +
                    '<span class="snippet-name">' + highlightedName + '</span>' +
                    (path ? '<span class="search-result-path">' + path + '</span>' : '');
                
                el.onclick = () => navigateToItem(item);
                content.appendChild(el);
            });
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
            while (current.parentId) {
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
                while (parent && parent.type !== 'tab') {
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
                while (p) {
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

# AcidSnip

**AcidSnip** is a powerful extension for VS Code designed to boost your productivity. It allows you to store, organize, and execute your recurring terminal commands through a modern, customizable, and highly interactive interface.

## 🚀 Advanced Features

*   **Modern Webview UI**: A fluid and responsive interface with horizontal tabs and a dynamic sidebar.
*   **Smart Snippets**: Create snippets with dynamic arguments using `{{arg$1:label}}` syntax. It prompts you for values before execution!
*   **Intelligent Search**: Quickly find any snippet, folder, or tab across your entire collection with real-time highlighting.
*   **Folder Support**: Organize your snippets into nested folders. Delete folders while keeping their contents if needed.
*   **Drag & Drop Everything**: Reorganize snippets, folders, and tabs with a simple drag and drop interface.
*   **External Config Storage**: Store your snippets and settings in an external JSON file for easy portability, backup, and sharing.
*   **Responsive Sidebar**: The toolbar automatically switches from a vertical sidebar to a horizontal bottom bar when vertical space is limited.
*   **Dynamic Version Checker**: Automatically detects the local version of your project (package.json, Cargo.toml, etc.) and compares it with the latest GitHub release.
*   **HTML Color Picker**: Fully customize the look of your tabs, folders, and snippets with a built-in color picker.
*   **Emoji Picker**: Integrated emoji selector with search to give style and personality to your commands.
*   **GitHub Repo Downloader**: Browse and clone public repositories from any GitHub user directly into your workspace with a single click.
*   **Quick Actions**:
    *   **Reload Extensions**: A dedicated button to quickly reload all VS Code extensions.
    *   **CD to Explorer Selection**: Instantly change your terminal directory to the folder or file selected in the VS Code explorer.
    *   **GitHub Integration**: Set a default username to quickly access your favorite repositories.
*   **Safety First**: Optional "Confirm before delete" setting to prevent accidental data loss.

## 🛠️ Installation

1.  Open **VS Code**.
2.  Go to the **Extensions** view (`Ctrl+Shift+X`).
3.  Search for **AcidSnip** or install via a `.vsix` file.

## 📖 How to Use

1.  **Open AcidSnip**: Click the terminal icon in the Activity Bar.
2.  **Add Elements**: Use the sidebar buttons to add a Snippet, Smart Snippet, Folder, Tab, or Separator.
3.  **Search**: Click the 🔍 icon or use the search bar to find your commands instantly.
4.  **Customize**: Right-click any element to change its color, edit its properties, or delete it.
5.  **Organize**: Drag snippets onto tabs to move them, or drag them within the list to reorder.
6.  **Execute**: Simply click a snippet to run its command in the terminal. If it's a Smart Snippet, fill in the requested arguments first.
7.  **GitHub Downloader**: Click the 🐙 icon to browse and clone repositories from any GitHub user.
8.  **Settings**: Click the ⚙️ icon to manage your configuration file, export/import data, and toggle advanced UI features like the GitHub button or Reload button.

## ⚙️ Technical Specifications

*   **Engine**: Built with `WebviewViewProvider` for a premium, custom UI experience.
*   **Storage**: Primary storage in external JSON files with `globalState` fallback.
*   **Design**: Fully theme-aware, using VS Code CSS variables to match your favorite theme perfectly.
*   **Responsive**: Adaptive layout for small sidebars or narrow windows.

---

> **AcidSnip**: Your commands, your style, your speed.

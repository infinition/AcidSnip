# AcidSnip 🚀

**AcidSnip** is a premium VS Code extension designed to revolutionize your terminal workflow. It provides a modern, highly interactive interface to store, organize, and execute your recurring commands with unparalleled speed and style.

---

## ✨ Key Features

### 📑 Smart Tab System (New!)
*   **Overflow Menu**: Automatically detects when tabs run out of space and provides a sleek chevron menu (⌄) to access hidden tabs.
*   **Drag & Drop Magic**:
    *   **Auto-Open**: Drag an item over a tab (or a hidden tab in the overflow menu) to instantly switch to it.
    *   **Folder Expansion**: Hover over a collapsed folder while dragging to automatically pop it open.
    *   **Smart Focus**: Dropping an item onto a hidden tab scrolls it into view so you never lose track.
*   **Discrete Scrollbar**: A subtle horizontal scrollbar is available for manual navigation.

### 🕒 Integrated History & Clipboard
*   **Native History Tab**: Access your history directly as a dedicated tab in the main UI.
*   **Command Tracking**: Automatically stores your last 20 executed commands.
*   **Clipboard Monitoring**: Intelligently tracks your last 20 clipboard entries.
*   **Interactive Actions**:
    *   **📋 Quick Copy**: Hover over any command history item to reveal a discrete copy button.
    *   **📥 Direct Insert**: Send clipboard content directly to your terminal or editor.
    *   **Smart Toggle**: Click the history icon (🕒) again to instantly close it and return to your previous tab.

### ⚙️ Refined UI & Settings
*   **Anchored Controls**:
    *   **Execution Mode (💻/🔒)**: Fixed to the far left for quick access.
    *   **Settings (⚙️)**: Fixed to the far right, ensuring it's always visible.
*   **Optimized Settings Menu**:
    *   **Tabbed Interface**: Clean separation between Display and Config settings.
    *   **Auto-Save**: Changes are saved automatically when you close the menu.
    *   **Compact Design**: Perfectly sized for sidebars.

### ⚡ Smart Snippets & Organization
*   **Dynamic Arguments**: Use `{{arg$1:label}}` syntax to create interactive snippets.
*   **Deep Organization**: Nested **Folders**, **Tabs**, and **Separators**.
*   **Visual Customization**:
    *   **HTML Color Picker**: Color-code your tabs and folders.
    *   **Emoji Picker**: Find the perfect icon for your commands.

### 🐙 GitHub Repository Downloader
*   **Direct Integration**: Browse public repositories from any GitHub user.
*   **One-Click Clone**: Instantly clone repositories into your workspace.
*   **Smart Path Selection**: Reuses your explorer selection logic for the target directory.

### 🔍 Intelligent Search
*   **Real-Time Filtering**: Find snippets instantly as you type.
*   **Visual Highlighting**: Search terms are highlighted for quick identification.

### 🛠️ Advanced Utilities
*   **CD to Explorer Selection**: Sync your terminal directory with your file selection.
*   **Reload Extensions**: Quickly refresh your VS Code environment.
*   **Version Checker**: Compare your local version with the latest GitHub release.
*   **External Config**: Portable JSON configuration.

---

## 📖 How to Use

1.  **Open AcidSnip**: Click the terminal icon in the Activity Bar.
2.  **Organize**: Use the sidebar buttons to add Snippets, Folders, Tabs, or Separators.
3.  **Drag & Drop**: Move items freely. Hover over folders to expand them, or drag to the overflow menu to reach hidden tabs.
4.  **Execute**: Click a snippet to run it. Use **Locked Mode (🔒)** to prevent accidents.
5.  **History**: Click the 🕒 icon to view history. Click it again to close.
6.  **Settings**: Click the ⚙️ icon on the right to customize your experience.

---

## ⚙️ Technical Specifications

*   **Engine**: Built with `WebviewViewProvider` for a premium, custom UI experience.
*   **Storage**: External JSON files with `globalState` fallback.
*   **Design**: Fully theme-aware, using VS Code CSS variables.
*   **Responsive**: Adaptive layout with smart overflow handling.

---

> **AcidSnip**: Your commands, your style, your speed.

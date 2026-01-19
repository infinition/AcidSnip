# AcidSnip

**AcidSnip** is a powerful extension for VS Code designed to boost your productivity. It allows you to store, organize, and execute your recurring terminal commands through a modern and customizable interface.

## 🚀 Advanced Features

*   **Modern Webview Interface**: A fluid and responsive UI with horizontal tabs and a smart layout.
*   **Hierarchical Organization**: Organize your snippets into **Tabs** and **Folders** for maximum clarity.
*   **Full Drag & Drop**: Effortlessly reorganize snippets, folders, and tabs by dragging them.
*   **Smart Snippets**: Use arguments in your commands like `{{arg$1:label}}`. AcidSnip will prompt you for values before execution.
*   **Intelligent Search**: Quickly find any snippet, folder, or tab using the integrated search bar (🔍).
*   **Color Customization**: Personalize tabs, folders, snippets, and separators with a built-in color picker.
*   **Integrated Emoji Picker**: Add style to your items with a searchable emoji selector.
*   **External Configuration**: Save your data to an external JSON file (e.g., in OneDrive or Git) for easy synchronization across machines.
*   **Responsive Design**: The toolbar automatically switches to a horizontal bottom bar when vertical space is limited.
*   **Quick CD**: Right-click any file or folder in the VS Code explorer to instantly `cd` into it in the terminal.

## 🛠️ Installation

1.  Open **VS Code**.
2.  Go to the **Extensions** view (`Ctrl+Shift+X`).
3.  Search for **AcidSnip** or install via a `.vsix` file.

## 📖 How to Use

1.  **Open AcidSnip**: Click the terminal icon in the Activity Bar.
2.  **Add Elements**: Use the sidebar buttons to add a Snippet, Smart Snippet, Folder, Tab, or Separator.
3.  **Search**: Click the 🔍 icon or press the search button to filter your items.
4.  **Settings**: Click the ⚙️ icon to configure:
    *   **External Config File**: Choose where to store your data.
    *   **Confirm Delete**: Enable/disable confirmation prompts.
    *   **Reload Button**: Show/hide the extension reload button.
5.  **Execute**: Simply click a snippet to run its command in the active terminal.

## ⚙️ Technical Specifications

*   **Engine**: Built with `WebviewViewProvider` for a premium, custom UI.
*   **Storage**: Supports both `globalState` and external JSON file persistence.
*   **Theming**: Fully compatible with VS Code themes using CSS variables.

---

> **AcidSnip**: Your commands, your style, your speed.

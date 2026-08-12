<img width="302" height="302" alt="image-removebg-preview (15)" src="https://github.com/user-attachments/assets/4e56aeba-8263-47cc-b7d7-5731426546d4" />

# AcidSnip

[![License](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE) ![TypeScript](https://img.shields.io/badge/TypeScript-007ACC?style=flat&logo=typescript&logoColor=white) [![Release](https://img.shields.io/github/v/release/infinition/AcidSnip?style=flat)](https://github.com/infinition/AcidSnip/releases) [![Buy Me a Coffee](https://img.shields.io/badge/Buy%20Me%20a%20Coffee-ffdd00?style=flat&logo=buy-me-a-coffee&logoColor=black)](https://buymeacoffee.com/infinition)

A VS Code extension that adds a sidebar panel for storing, organizing, and executing terminal commands. Snippets support dynamic arguments, nested folders, tabs, and drag-and-drop reordering.

<img width="1178" height="644" alt="AcidSnip interface" src="https://github.com/user-attachments/assets/97e6abb6-8644-4228-97d9-2047e4bb71af" />

---

## Features

### Tab system

- Tabs with overflow menu when there are too many to display.
- Drag an item over a tab to switch to it automatically.
- Hover over a collapsed folder while dragging to expand it.
- Subtle horizontal scrollbar for manual tab navigation.

### History and clipboard

- Dedicated History tab showing the last 20 executed commands and last 20 clipboard entries.
- Hover over any history item to copy it or send it directly to the terminal.
- Click the history icon again to close the panel and return to the previous tab.

### Snippets and organization

- Dynamic arguments with `{{arg$1:label}}` syntax for interactive prompts.
- Nested folders, tabs, and separators.
- Color picker and emoji picker for visual organization.
- Real-time search with match highlighting.

### Utilities

- CD to current Explorer selection.
- GitHub repository browser with one-click clone.
- Reload extensions shortcut.
- Version checker against the latest GitHub release.

---

## Storage

By default all data is stored in VS Code's `globalState`. No file is created and no setup is needed.

To use an external file, open Settings (gear icon, top right) > Config > Select File. From that point on the JSON file is the source of truth. The file path itself is stored internally. History always stays in `globalState`.

Config file structure:

```json
{
  "items": [],
  "settings": {}
}
```

Export creates a portable snapshot without changing the active config. Import replaces current snippets and settings from a file.

---

## Usage

1. Click the AcidSnip icon in the Activity Bar to open the sidebar.
2. Add snippets, folders, tabs, or separators with the toolbar buttons.
3. Click a snippet to run it. Enable Locked Mode (lock icon) to prevent accidental execution.
4. Drag items to reorder. Hover over folders or overflow tabs while dragging to navigate.
5. Click the clock icon to open history. Click it again to close.

---

## Technical

- Built with `WebviewViewProvider` for a fully custom UI.
- Storage: external JSON with `globalState` fallback.
- Fully theme-aware using VS Code CSS variables.

---

## Star History

<a href="https://www.star-history.com/?repos=infinition%2FAcidSnip&type=date&legend=top-left">
 <picture>
   <source media="(prefers-color-scheme: dark)" srcset="https://api.star-history.com/chart?repos=infinition/AcidSnip&type=date&theme=dark&legend=top-left" />
   <source media="(prefers-color-scheme: light)" srcset="https://api.star-history.com/chart?repos=infinition/AcidSnip&type=date&legend=top-left" />
   <img alt="Star History Chart" src="https://api.star-history.com/chart?repos=infinition/AcidSnip&type=date&legend=top-left" />
 </picture>
</a>

---

## License

MIT. See [LICENSE](LICENSE).

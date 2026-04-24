# Bulk Tag Manager

![Bulk Tag Manager Art](https://github.com/user-attachments/assets/bc234f8a-a52c-41d7-a563-0c4676600dc7)

[![ko-fi](https://ko-fi.com/img/githubbutton_sm.svg)](https://ko-fi.com/ducktapekiller)

**Bulk Tag Manager** is a comprehensive tag management utility for Obsidian. It provides a unified, professional dashboard to rename, merge, standardize, and organize tags across your entire vault.

> [!WARNING]
> **Backup Required**: This plugin modifies files in bulk. Always backup your vault before running bulk operations.

---

## Features

### 📊 Dashboard Overview
The plugin features a clean, boxed dashboard interface broken down into logical sections.

#### Tag Statistics
At the top of the dashboard, expand the **Overview** section to see:
- **Total Tags**: Count of unique tags in your vault.
- **Affected Files**: Number of notes containing tags.
- **Inline Tags**: Notes containing tags in the body text (e.g. `#tag`).
- **Nested Tags**: Notes containing hierarchical tags (e.g. `#parent/child`).
- **Location**: Breakdown of frontmatter vs. body tags.

Clicking any statistic opens a detailed list of the relevant files.

---

### 🏷️ Rename & Merge

#### Tag Renaming
Rename any tag across all files (Frontmatter & Inline).
1. Go to the **Rename Tag** section.
2. Enter the **Find** tag (or use the Search button to browse).
3. Enter the **Replace** tag.
4. Click **Rename**.
*Automatic nesting support: Renaming `#project` will also update `#project/task`.*

#### Tag Merging
Consolidate synonyms into a single tag.
1. Go to the **Merge Tags** section.
2. Enter **Source tags** (comma-separated, e.g. `#film, #movie`).
3. Enter **Target** tag (e.g. `#cinema`).
4. Click **Merge**.

#### Pattern-Based Renaming (Regex)
Advanced restructuring using Regular Expressions.
1. Go to **Pattern Rename**.
2. Enter a **Pattern** (e.g., `^category-(.*)`).
3. Enter a **Replacement** (e.g., `new-category/$1`).
4. Click **Apply**.

---

### 🧹 Bulk Standardization & Settings

#### Conversion Rules
Configure how tags should be formatted vault-wide:
- **Case Strategy**: Lowercase, Uppercase, or No Change.
- **Separator Style**: Snake_case, Kebab-case, or Preserve.
- **Remove Special Characters**: Strip non-alphanumeric characters.
- **Apply to Nested Tags**: Whether to process child tags.

#### Scope Filtering
Limit operations to specific parts of your vault.
1. Enable **Scope Filter**.
2. Use **Include** to specify folders to process (e.g., `Items/Active`).
3. Use **Exclude** to protect specific folders (e.g., `Templates`, `Archive`).

#### Fix Invalid Formats
Click **Fix Invalid** (Check Square icon) to detect and repair malformed tags in frontmatter (e.g., missing commas, invalid spaces).

---

### 🛠️ Tools & Utilities

- **🌲 Hierarchy View**: Visualize your tags as a collapsible tree to understand your taxonomy.
- **🔍 Orphan Detection**: Find tags with low usage (configurable threshold) to identify clutter.
- **📋 Tag List**: Generate a markdown file (`All Tags.md`) listing every tag and its usage count.
- **🔄 History & Undo**: Every operation is recorded. Click **History** to view a log of changes and **Undo** any operation to revert files to their previous state.

---

### ⚡ Tag Aliases
Define automatic correction rules in **Settings**.
1. Go to **Settings → Bulk Tag Manager → Aliases**.
2. Add an Alias (e.g. `wip`) and a Canonical tag (e.g. `work-in-progress`).
3. Whenever you save a note with `#wip`, it automatically converts to `#work-in-progress`.

---

## Installation

1. Download the latest release from GitHub.
2. Extract `main.js`, `manifest.json`, and `styles.css` into `<vault>/.obsidian/plugins/bulk-tag-manager/`.
3. Reload Obsidian and enable the plugin.

## Usage
- Click the **Tags icon** in the left ribbon for Tag Wrangler-style quick actions.
- Use **Settings → Bulk Tag Manager** for bulk operations, vault-wide cleanup, and advanced tools.
- Or use Command Palette: `Bulk Tag Manager: Open Bulk Tag Manager Settings`.

---

## Commands
| Command | Description |
|---------|-------------|
| `Open Tag Manager Dashboard` | Opens the main interface |
| `Convert all tags (with preview)` | runs bulk conversion based on settings |
| `Undo Last Tag Operation` | Quick undo |
| `Find Orphaned Tags` | Scan for unused tags |

---

## Tips
- **Use Preview**: The bulk convert option offers a preview of changes.
- **Check History**: Use the History modal to verify exactly what files were changed.
- **Scope Filters**: Use them to test operations on a sandbox folder first.

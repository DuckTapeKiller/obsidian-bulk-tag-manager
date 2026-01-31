# Bulk Tag Manager

![Bulk Tag Manager Art](https://github.com/user-attachments/assets/bc234f8a-a52c-41d7-a563-0c4676600dc7)

[![ko-fi](https://ko-fi.com/img/githubbutton_sm.svg)](https://ko-fi.com/ducktapekiller)

**Bulk Tag Manager** is a comprehensive tag management utility for Obsidian. It provides a unified dashboard to rename, merge, standardize, and organize tags across your entire vault.

> [!WARNING]
> **Backup Required**: This plugin modifies files in bulk. Always backup your vault before running bulk operations.

---

## Features

### Tag Renaming
Rename any tag across all files in your vault. The plugin updates both frontmatter tags and inline tags in the document body.

**How to use:**
1. Open the dashboard (ribbon icon or command palette)
2. In the **Rename Tag** section, enter the old tag and new tag
3. Click the 🔍 button to browse existing tags with autocomplete
4. Click **Rename**

The plugin handles nested tags automatically—renaming `#project` will also update `#project/work` to `#newname/work`.

---

### Tag Merging
Combine multiple tags into a single target tag. Useful for consolidating synonyms or cleaning up duplicate concepts.

**How to use:**
1. Open the dashboard
2. In the **Merge Tags** section, enter source tags separated by commas (e.g., `#movie, #film, #movies`)
3. Enter the target tag (e.g., `#film`)
4. Click **Merge**

All source tags will be replaced with the target tag throughout your vault.

---

### Pattern-Based Renaming
Use regular expressions to rename tags matching a pattern. Powerful for bulk restructuring.

**How to use:**
1. Open the dashboard
2. In the **Pattern Rename** section, enter a regex pattern (e.g., `^old-(.*)`)
3. Enter the replacement string using capture groups (e.g., `new-$1`)
4. Click **Apply**

**Examples:**
| Pattern | Replacement | Effect |
|---------|-------------|--------|
| `^2024-` | `year-2024/` | `#2024-january` → `#year-2024/january` |
| `_` | `-` | `#my_tag` → `#my-tag` |
| `^(.*)-(draft)$` | `$2/$1` | `#post-draft` → `#draft/post` |

---

### Preview Mode
Before applying any bulk operation, preview all changes in a detailed diff view.

**What it shows:**
- List of all affected files
- Line-by-line before/after comparison
- Number of changes per file

**Features:**
- Checkbox to include/exclude individual files
- Select All / Select None buttons
- Cancel to abort without changes

---

### Undo History
Every operation is recorded with full file snapshots, allowing you to revert changes.

**How to use:**
1. Click **📜 History** in the dashboard
2. View past operations with timestamps and affected file counts
3. Click **Undo** on the most recent operation to revert

**Settings:**
- Configure max history size (10-100 operations)
- Clear all history from Settings

---

### Tag Hierarchy Visualization
View all your tags as a collapsible tree structure, showing parent/child relationships.

**How to use:**
1. Click **🌲 Hierarchy** in the dashboard
2. Browse the tree view with usage counts per tag

**Display:**
- 📁 indicates tags with nested children
- 🏷️ indicates leaf tags
- Numbers show how many times each tag is used

---

### Orphaned Tag Detection
Find tags that are rarely used in your vault, helping identify candidates for cleanup.

**How to use:**
1. Click **🔍 Orphans** in the dashboard
2. View all tags below the usage threshold

**Settings:**
- Configure the threshold in Settings (default: 2 uses)

---

### Tag Aliases
Define aliases that automatically correct to canonical tag names when you edit a file.

**How to use:**
1. Go to Settings → Bulk Tag Manager
2. In the **Aliases** section, add alias → canonical mappings
3. When you type an alias tag and save the file, it auto-corrects

**Example:**
- Alias: `films` → Canonical: `movies`
- When you save a file containing `#films`, it becomes `#movies`

---

### Scope Filtering
Limit operations to specific folders in your vault.

**How to use:**
1. In the dashboard, enable **Scope Filter**
2. Enter comma-separated folder paths to include (e.g., `projects, notes/work`)
3. Enter folders to exclude (e.g., `templates, archive`)

Operations will only affect files matching your filter.

---

### Bulk Conversion Settings
Standardize all tags with configurable rules:

| Setting | Options | Effect |
|---------|---------|--------|
| **Case Strategy** | Lowercase, Uppercase, None | `#MyTag` → `#mytag` |
| **Separator Style** | Preserve, Snake, Kebab | `#my-tag` ↔ `#my_tag` |
| **Remove Special Characters** | On/Off | Strip non-alphanumeric chars |
| **Apply to Nested Tags** | On/Off | Process child tags in `#parent/child` |

Click **🔄 Convert All** to apply these rules to all tags vault-wide.

---

### Tag List Generator
Export all tags to a markdown file for review.

**How to use:**
1. Click **📋 Tag List** in the dashboard
2. A file named `All Tags.md` is created/updated in your vault root

The file contains a sorted list of all tags with usage counts.

---

## Installation

1. Download the latest release from GitHub
2. Extract `main.js`, `manifest.json`, and `styles.css` to:
   ```
   <your-vault>/.obsidian/plugins/bulk-tag-manager/
   ```
3. Reload Obsidian
4. Enable the plugin in Settings → Community Plugins

---

## Accessing the Dashboard

- Click the **Tags icon** in the left ribbon
- Or use Command Palette: `Bulk Tag Manager: Open Tag Manager Dashboard`

---

## Commands

| Command | Description |
|---------|-------------|
| `Open Tag Manager Dashboard` | Opens the main dashboard |
| `Convert all tags (with preview)` | Runs bulk conversion with preview |
| `Generate Tag List` | Creates the All Tags.md file |
| `Show Tag Hierarchy` | Opens the hierarchy view |
| `Find Orphaned Tags` | Opens the orphan tags view |
| `Undo Last Tag Operation` | Reverts the most recent operation |

---

## Tips

- **Always preview first**: Use Preview Mode to check changes before applying
- **Start with small scopes**: Use Scope Filter to test on a specific folder
- **Use the history**: If something goes wrong, undo immediately
- **Backup regularly**: While undo exists, a vault backup is your safety net

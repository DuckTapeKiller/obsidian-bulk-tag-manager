# Bulk Tag Manager

![Bulk Tag Manager Art](https://github.com/user-attachments/assets/bc234f8a-a52c-41d7-a563-0c4676600dc7)

[![ko-fi](https://ko-fi.com/img/githubbutton_sm.svg)](https://ko-fi.com/ducktapekiller)

**Bulk Tag Manager** is a comprehensive tag management utility for Obsidian. It provides a unified, professional dashboard to rename, merge, delete, clean, standardise, and organise both tags and front matter properties across your entire vault. This plugin absorbed the functionalities from [Tag Wrangler](https://github.com/pjeby/tag-wrangler), by [pjeby](https://github.com/pjeby).

---

## Table of Contents

- [Features](#colorredtextfeatures)
    - [Dashboard Overview](#colorbluetextdashboard-overview)
    - [Rename, Merge, and Delete](#colorbluetextrename-merge-and-delete)
    - [Bulk Standardisation and Settings](#colorbluetextbulk-standardisation-and-settings)
    - [Metadata Utilities](#colorbluetextmetadata-utilities)
    - [Tools](#colorbluetexttools)
    - [Protected Tags](#colorbluetextprotected-tags)
    - [Tag Aliases](#colorbluetexttag-aliases)
    - [Context Menu Integration](#colorbluetextcontext-menu-integration)
- [Installation](#colorredtextinstallation)
- [Usage](#colorredtextusage)
- [Commands](#colorredtextcommands)
- [Tips](#colorredtexttips)
- [Acknowledgements](#colorredtextacknowledgements)

---

> [!WARNING]
> This plugin contains a History system that allows you to undo any operation. However, if you are about to perform a destructive bulk process, it is recommended that you backup your vault before running bulk operations.

---

## $\color{red}{\text{Features}}$

### $\color{blue}{\text{Dashboard Overview}}$

The plugin provides two interfaces:

- **Quick Actions Modal** -- Accessed from the ribbon icon (Tags). Provides single-tag operations: rename, delete, search, tag page creation, and random note.
- **Settings Dashboard** -- Accessed from Settings or the Command Palette. Contains the full suite of bulk operations, vault-wide statistics, and advanced tools.

#### $\color{orange}{\text{Tag Statistics}}$

At the top of the Settings Dashboard, expand the **Overview** section to see real-time analytics:

- **Total Tags** -- Count of unique tags in your vault.
- **Total Files** -- Number of notes in the current scope.
- **Case Consistency** -- Breakdown of lowercase, uppercase, and mixed-case tags with a consistency progress bar.
- **Separator Consistency** -- Breakdown of kebab-case, snake_case, mixed, and unseparated tags.
- **Clean Tags and Front Matter** -- Count of clean tags vs. tags with special characters, plus detection of notes with unnecessarily quoted properties.
- **Tag Format Style** -- Count of files using YAML list format vs. inline array format, with one-click conversion buttons.
- **Wiki Link Format Style** -- Same format breakdown for wiki link properties (`aliases`, `cssclasses`, etc.).
- **Tag Nesting** -- Count of flat vs. nested (hierarchical) tags, with links to files containing nested tags.
- **Locations** -- Breakdown of tags in frontmatter vs. tags in the document body, with links to files containing inline body tags.
- **Length** -- Detection of unusually long tags (over 25 characters).
- **Case Duplicates** -- Automatic detection of tags that differ only by case (e.g. `#Project` vs `#project`), with a one-click "Merge all to canonical" button.
- **Empty Tags** -- Detection of files with empty tag fields in frontmatter.

Clicking any statistic opens a detailed list of the relevant tags or files.

#### $\color{orange}{\text{Invalid Tag Detection}}$

If any files contain malformed YAML tag syntax (missing commas, unquoted colons, invalid formatting), an **Invalid Tags** warning block appears below the Overview. Clicking **Fix Invalid** opens a modal where you can review each issue and apply automatic or manual fixes.

---

### $\color{blue}{\text{Rename, Merge, and Delete}}$

#### $\color{orange}{\text{Tag Renaming}}$

Rename any tag across all files, in both frontmatter and the document body.

1. Go to the **Rename Tag** section.
2. Enter the **Find** tag (or use the Search button to browse existing tags with usage counts).
3. Enter the **Replace** tag. If the target tag already exists, a warning is displayed indicating the rename will merge the tags.
4. Click **Rename**.

Child tags are automatically updated: renaming `#project` to `#work` will also rename `#project/active` to `#work/active` in both frontmatter and body.

#### $\color{orange}{\text{Batch Rename}}$

Rename multiple tags simultaneously using a dedicated table of old/new pairs.

1. Go to the **Batch Rename** section.
2. Add as many rows as needed.
3. Enter the **Old Tag** and **New Tag** for each row.
4. Click **Apply**.

This is ideal for quickly reorganising small groups of tags without running multiple single rename operations.

#### $\color{orange}{\text{Batch Rename from CSV}}$

Perform large-scale tag restructuring by uploading a data file.

1. Go to the **Batch Rename from CSV** section.
2. Click **Choose CSV** and select a file with two columns: `old_tag` and `new_tag`.
3. Review the **Preview** of the first few pairs to ensure correct loading.
4. Click **Apply**.

The CSV should not contain headers or the `#` symbol (though the plugin handles them if present).

#### $\color{orange}{\text{Tag Merging}}$

Consolidate multiple tags into a single canonical tag.

1. Go to the **Merge Tags** section.
2. Enter **Source tags** (comma-separated, e.g. `#film, #movie`), or use the **Select** button for a multi-select modal with checkboxes.
3. Enter a **Target** tag (e.g. `#cinema`).
4. Click **Merge**.

Duplicate tags in the same file are automatically deduplicated after merging. Child tags are propagated (e.g. `#film/drama` becomes `#cinema/drama`).

#### $\color{orange}{\text{Nest Tags}}$

Create hierarchical structures by moving existing tags under a new parent.

1. Go to the **Nest Tags** section.
2. Enter the **Parent tag** (e.g. `#work`).
3. Enter the **Tags to nest** (comma-separated, e.g. `#meetings, #tasks`).
4. Click **Nest**.

Each child tag will be renamed to include the parent prefix (e.g. `#work/meetings` and `#work/tasks`).

#### $\color{orange}{\text{Tag Deletion}}$

Remove tags from all files in the current scope.

1. Go to the **Delete Tags** section.
2. Enter tags to delete (comma-separated), or use the **Select** or **Search** buttons.
3. Click **Delete**.

Deleting a parent tag also removes its child tags (e.g. deleting `#project` also removes `#project/active` and `#project/done`). Tags are removed from both frontmatter arrays and inline body occurrences. Trailing whitespace artifacts are automatically cleaned up.

#### $\color{orange}{\text{Pattern-Based Renaming (Regex)}}$

Advanced tag restructuring using Regular Expressions.

1. Go to **Pattern Rename (Regex)**.
2. Enter a **Pattern** (e.g. `^category-(.*)`).
3. Enter a **Replacement** (e.g. `new-category/$1`).
4. Click **Apply**.

Regex complexity is limited to prevent catastrophic backtracking (ReDoS). Frontmatter content is excluded from pattern matching to prevent YAML corruption.

---

### $\color{blue}{\text{Bulk Standardisation and Settings}}$

#### $\color{orange}{\text{Conversion Rules}}$

Configure how tags should be formatted vault-wide:

- **Case Strategy** -- Lowercase, Uppercase, or No Change.
- **Separator Style** -- Snake_case, Kebab-case, or Preserve.
- **Remove Special Characters** -- Strip everything except letters, numbers, hyphens, and underscores.
- **Flatten Diacritics** -- Convert accented characters to their plain equivalents (e.g. a to a).
- **Apply to Nested Tags** -- Whether to process child tags during conversion.

Click **Convert All** to apply these rules across all files in the current scope. A preview modal shows exactly which files and lines will be changed before you confirm.

#### $\color{orange}{\text{Bulk Case Conversion}}$

In the **Case** statistics box, two buttons allow you to convert all tags in your vault to uppercase or lowercase in a single operation, independent of the Case Strategy setting.

#### $\color{orange}{\text{Scope Filtering}}$

Limit all operations to specific parts of your vault.

1. Enable **Scope Filter**.
2. Use **Include Folders** to specify which folders to process.
3. Use **Exclude Folders** to protect specific folders (e.g. `Templates`, `Archive`).
4. Optionally set a **File Pattern Filter** (regex) applied to file paths for fine-grained control.

All statistics, conversions, and bulk operations respect the active scope filter.

---

### $\color{blue}{\text{Metadata Utilities}}$

#### $\color{orange}{\text{Clean Front Matter Formatting}}$

Removes unnecessary quotes and trims whitespace from all frontmatter fields across the vault. This addresses Obsidian's tendency to add defensive quoting around property values.

#### $\color{orange}{\text{Standardise to Inline Array}}$

Converts both tag properties and wiki link properties (such as `aliases` and `cssclasses`) to the inline array format (`[value1, value2]`) across all files in the current scope.

#### $\color{orange}{\text{Standardise to YAML List}}$

Converts both tag properties and wiki link properties to the multiline YAML list format across all files:

```yaml
tags:
  - tag1
  - tag2
```

#### $\color{orange}{\text{Tag Format Conversion}}$

In the **Tag Format Style** statistics box, you can convert tags specifically (without affecting wiki link properties) between YAML list and inline array formats.

#### $\color{orange}{\text{Wiki Link Format Conversion}}$

In the **Wiki Link Format Style** statistics box, you can convert wiki link properties specifically between YAML list and inline array formats.

---

### $\color{blue}{\text{Tools}}$

#### $\color{orange}{\text{Hierarchy View}}$

Visualise your tags as a collapsible, searchable tree to understand your taxonomy. Includes:

- A search field to filter the tree in real time.
- A sort dropdown (alphabetical, by count, by depth).
- Expand All / Collapse All controls.
- Click counts to see usage per tag node.

#### $\color{orange}{\text{Orphan Detection}}$

Find tags used fewer times than a configurable threshold (default: 2 files). The orphan modal lists all matching tags with their usage counts and provides a **Delete All Orphans** button for bulk cleanup.

#### $\color{orange}{\text{Tag List}}$

Generate a markdown file (`All Tags.md`) in your vault root listing every tag and its usage count, sorted alphabetically.

If `All Tags.md` already exists, you are asked to confirm before it is replaced, and its previous contents are written to undo history first.

#### $\color{orange}{\text{History and Undo}}$

Every destructive operation (rename, merge, delete, convert, pattern rename, format conversion, property cleaning) is recorded with full file snapshots.

- Click **History** to view a chronological log of all operations.
- Click **Undo** on any operation to revert every affected file to its exact state before the operation.
- Notes you have edited since the operation ran are left untouched, so an undo cannot discard newer work. Any skipped notes are listed after the undo completes, and can be corrected by hand.
- History is stored externally in the plugin's data directory to keep `data.json` small.
- Configure **Max History Size** (default: 50 entries) and **History Expiration** (default: 7 days) in Settings.

---

### $\color{blue}{\text{Protected Tags}}$

Define tags that should never be modified by any rename, merge, or delete operation.

1. Go to **Settings > Bulk Tag Manager > Protected Tags**.
2. Add a tag (e.g. `#status/active`).
3. Use a wildcard (`*`) for prefix matching (e.g. `#status/*` protects `#status/active`, `#status/done`, etc.).

Protected tags are silently skipped during all bulk operations.

---

### $\color{blue}{\text{Tag Aliases}}$

Define automatic correction rules that trigger when you save a note.

1. Go to **Settings > Bulk Tag Manager > Aliases**.
2. Add an Alias (e.g. `wip`) and a Canonical tag (e.g. `work-in-progress`).
3. Whenever you save a note containing `#wip`, it is automatically corrected to `#work-in-progress`.

Aliases work in both frontmatter and the document body. Child tags are also corrected (e.g. `#wip/urgent` becomes `#work-in-progress/urgent`). A debounce timer prevents conflicts during rapid editing.

---

### $\color{blue}{\text{Context Menu Integration}}$

Right-click any tag in the **tag pane**, **editor**, **reading view**, or **metadata properties** panel to access:

- **Rename** -- Opens the rename prompt for that tag.
- **Delete** -- Deletes the tag with confirmation.
- **Open / Create Tag Page** -- Opens an existing tag page or creates a new one with the tag as an alias.
- **New Search** -- Opens a global search scoped to the tag.
- **Require in Search** -- Adds the tag as a required filter to the current search query.
- **Exclude from Search** -- Excludes the tag from the current search query.
- **Open Random Note** -- Opens a random note tagged with the selected tag (requires the Smart Random Note plugin).

Tags can also be **dragged and dropped** in the tag pane to restructure the hierarchy (e.g. dragging `active` onto `project` renames it to `project/active`).

Holding **Ctrl/Cmd + Click** on any tag in the editor or reading view opens its tag page, or prompts to create one.

---

## $\color{red}{\text{Installation}}$

1. Download the latest release from GitHub.
2. Extract `main.js`, `manifest.json`, and `styles.css` into `<vault>/.obsidian/plugins/bulk-tag-manager/`.
3. Reload Obsidian and enable the plugin.

---

## $\color{red}{\text{Usage}}$

- Click the **Tags icon** in the left ribbon for quick single-tag actions (rename, delete, search, tag page, random note).
- Use **Settings > Bulk Tag Manager** for bulk operations, vault-wide cleanup, statistics, and advanced tools.
- Right-click any tag in the tag pane, editor, or reading view for contextual actions.
- Use the Command Palette for direct access to common operations.

---

## $\color{red}{\text{Commands}}$

| Command | Description |
|---------|-------------|
| `Open Bulk Tag Manager Settings` | Opens the full settings dashboard |
| `Convert all tags (with preview)` | Runs bulk conversion based on current settings with a preview |
| `Generate Tag List` | Creates a markdown file listing all tags and their usage counts |
| `Show Tag Hierarchy` | Opens the tag hierarchy tree view |
| `Find Orphaned Tags` | Scans for tags below the usage threshold |
| `Undo Last Tag Operation` | Reverts the most recent operation |

---

## $\color{red}{\text{Tips}}$

- **Use Preview**: The bulk convert option shows a preview of every change before applying. Use it to verify before committing.
- **Check History**: Use the History modal after any operation to verify exactly which files were changed and to undo if needed.
- **Scope Filters**: Use Include/Exclude folders to test operations on a sandbox folder before running them vault-wide.
- **Protected Tags**: Add critical tags (e.g. `#status/*`) to the protected list before running bulk operations to prevent accidental modification.
- **Case Duplicates**: Run the case duplicate check periodically. Tags like `#Project` and `#project` are treated as separate tags by Obsidian and can cause inconsistencies.

---

## $\color{red}{\text{Acknowledgements}}$

This plugin incorporates and extends the context menu and tag page functionality originally created by [pjeby](https://github.com/pjeby) in the [Tag Wrangler](https://github.com/pjeby/tag-wrangler) plugin.

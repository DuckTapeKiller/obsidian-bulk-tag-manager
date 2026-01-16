# Bulk Tag Manager

[![ko-fi](https://ko-fi.com/img/githubbutton_sm.svg)](https://ko-fi.com/ducktapekiller)

**Bulk Tag Manager** is a comprehensive utility for Obsidian that helps you clean, standardize, and organize your tags across the entire vault.

It provides a dashboard to rename specific tags, enforce casing rules (lowercase/uppercase), standardise separators (snake_case/kebab-case), and generate master tag lists.

> [!WARNING]
> **Backup Required**: This plugin modifies files in bulk (both frontmatter and inline content). Always backup your vault before running a "Convert All" operation.

## Features

* **Dashboard UI**: A central hub (Ribbon Icon) to view tag statistics and run operations.
* **Bulk Standardization**:
    * **Case Conversion**: Force all tags to **lowercase** or **UPPERCASE**.
    * **Separator Style**: Convert separators between **kebab-case** (`#my-tag`) and **snake_case** (`#my_tag`).
    * **Sanitization**: Option to strip special characters from tags.
    * **Nested Tags**: Choose whether to apply rules to nested tag parts (e.g., `#parent/child`).
* **Find & Replace**: Renames a specific tag across all files in your vault (handles both frontmatter and inline tags).
* **Tag List Generator**: Creates a markdown file (`All Tags.md`) listing every unique tag in your vault for easy review.

## How to Use

### The Dashboard
Click the **Dice Icon** in the left ribbon (or run the command `Open Tag Manager Dashboard`) to open the main interface.

From here you can:
1.  **View Stats**: See how many unique tags are in your vault and how many deviate from your current settings.
2.  **Change Settings**: Adjust casing and separator rules on the fly.
3.  **Run Actions**: Trigger bulk conversion or list generation.

### Renaming a Single Tag
Inside the Dashboard, look for the **"Rename Specific Tag"** section.
1.  Enter the **Old Tag** (e.g., `#typo`).
2.  Enter the **New Tag** (e.g., `#correction`).
3.  Click **Rename**.
The plugin will search all markdown files and update every instance of that tag.

### Bulk Conversion
To standardize your entire vault at once:
1.  Set your desired **Case Strategy** (e.g., Lowercase).
2.  Set your **Separator Style** (e.g., Kebab Case).
3.  Click **Convert All Tags**.
*Note: This processes every file in your vault. Large vaults may take a moment.*

### Generating a Tag List
Click **Generate Tag List** to create a file named `All Tags.md` in your vault root. This file contains a sorted list of every tag currently in use.

## Settings

* **Case Strategy**:
    * `Lowercase`: Converts `#MyTag` to `#mytag`.
    * `Uppercase`: Converts `#mytag` to `#MYTAG`.
    * `No Change`: Keeps casing as is.
* **Separator Style**:
    * `Preserve`: No changes.
    * `Snake Case`: Converts `#my-tag` to `#my_tag`.
    * `Kebab Case`: Converts `#my_tag` to `#my-tag`.
* **Remove Special Characters**: Removes symbols that are not letters, numbers, underscores, or hyphens.
* **Apply to Nested Tags**: If enabled, rules apply to all parts of a nested tag (e.g., `#Parent/Child` becomes `#parent/child`).

## Installation

1.  Download the latest release from GitHub.
2.  Extract `main.js`, `manifest.json`, and `styles.css` to your `.obsidian/plugins/bulk-tag-manager` folder.
3.  Reload Obsidian and enable the plugin.

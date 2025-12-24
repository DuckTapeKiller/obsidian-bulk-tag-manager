# Bulk Tag Manager Walkthrough

Bulk Tag Manager provides a central dashboard for efficient, vault-wide tag management, including advanced renaming and normalisation tools.

## Dashboard

Click the ribbon icon (dice) to open the Bulk Tag Manager dashboard. All actions and statistics are managed from this central interface.

## Rename a Specific Tag

Use this feature to correct typos or apply rebranding consistently across the entire vault.

- **Find**: Enter the existing tag, for example `#brwoser`.
- **Replace**: Enter the corrected tag, for example `#browser`.
- **Smart handling**: Nested tags are automatically updated, for example `#brwoser/history` becomes `#browser/history`.

## Dashboard Statistics and Settings

### Statistics
- **Total unique tags**: Displays the number of distinct tags in the vault.
- **Tags to be updated**: Real-time count of tags affected by the current configuration.

### Quick Settings
- **Case strategy**: Lowercase or uppercase.
- **Separator style**: Snake case, kebab case or preserve existing separators.
- **Remove special characters**: Optional sanitisation for improved consistency.

## Actions

- **Convert all tags**: Applies the selected rules to all tags in the vault.
- **Generate tag list**: Creates an `All Tags.md` file containing a sorted list of all tags.

## Core Features

- **Unicode support**: Fully compatible with international characters, for example `#café` and `#música`.
- **Flexible rules**: Casing and separator strategies can be combined as required.
- **Safety**: All updates are performed using the official Obsidian API.

## Installation

1. Navigate to `.obsidian/plugins/`.
2. Create or rename a folder to `obsidian-bulk-tag-manager`.
3. Copy the following files into the folder:
   - `main.js`
   - `manifest.json`
4. Reload Obsidian and enable **Bulk Tag Manager** in the community plugins settings.

A note on safety:

Please be extremely cautious. Changes made to your tags are permanent and cannot be automatically reverted. While I have tested the plugin thoroughly and encountered no issues, you should back up your vault before use. I am sharing this plugin in good faith, but I cannot be held responsible for any issues resulting from its use.

[![ko-fi](https://ko-fi.com/img/githubbutton_sm.svg)](https://ko-fi.com/ducktapekiller)

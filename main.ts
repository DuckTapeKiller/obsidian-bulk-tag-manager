import { App, Editor, MarkdownView, Modal, Notice, Plugin, PluginSettingTab, Setting, TFile, TextComponent } from 'obsidian';

interface TagLowercaseSettings {
    caseStrategy: 'lowercase' | 'uppercase' | 'none';
    separatorStrategy: 'preserve' | 'snake' | 'kebab';
    removeSpecialChars: boolean;
    applyToNestedTags: boolean;
}

const DEFAULT_SETTINGS: TagLowercaseSettings = {
    caseStrategy: 'lowercase',
    separatorStrategy: 'preserve',
    removeSpecialChars: false,
    applyToNestedTags: true
}

export default class TagLowercasePlugin extends Plugin {
    settings: TagLowercaseSettings;

    async onload() {
        await this.loadSettings();

        // Ribbon Icon - Opens Dashboard
        this.addRibbonIcon('dice', 'Bulk Tag Manager', (evt: MouseEvent) => {
            new TagManagerModal(this.app, this).open();
        });

        // Commands
        this.addCommand({
            id: 'open-tag-manager',
            name: 'Open Tag Manager Dashboard',
            callback: () => {
                new TagManagerModal(this.app, this).open();
            }
        });

        this.addCommand({
            id: 'convert-all-tags',
            name: 'Convert all tags (run immediately)',
            callback: async () => {
                await this.runConversion();
            }
        });

        this.addCommand({
            id: 'generate-tag-list',
            name: 'Generate Tag List',
            callback: async () => {
                await this.generateTagList();
            }
        });

        // Settings Tab
        this.addSettingTab(new TagLowercaseSettingTab(this.app, this));
    }

    async loadSettings() {
        this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
        // Migration logic
        const data = await this.loadData();
        if (data && data.snakeCase !== undefined) {
            this.settings.separatorStrategy = data.snakeCase ? 'snake' : 'preserve';
            delete data.snakeCase;
            await this.saveSettings();
        }
    }

    async saveSettings() {
        await this.saveData(this.settings);
    }

    // --- Core Features ---

    async runConversion() {
        const files = this.app.vault.getMarkdownFiles();
        let processedCount = 0;
        new Notice(`Starting conversion on ${files.length} files...`);

        for (const file of files) {
            try {
                await this.processFile(file);
                processedCount++;
            } catch (e) {
                console.error(`Failed to process file ${file.path}:`, e);
            }
        }
        new Notice(`Completed. Processed ${processedCount} files.`);
    }

    async generateTagList() {
        const tags = this.app.metadataCache.getTags();
        if (!tags) {
            new Notice('No tags found in vault.');
            return;
        }

        const sortedTags = Object.keys(tags).sort((a, b) => a.localeCompare(b));

        if (sortedTags.length === 0) {
            new Notice('No tags found to list.');
            return;
        }

        const fileContent = `# All Tags\n\n${sortedTags.map(t => `- ${t}`).join('\n')}\n`;
        const fileName = 'All Tags.md';

        try {
            const existingFile = this.app.vault.getAbstractFileByPath(fileName);
            if (existingFile instanceof TFile) {
                await this.app.vault.modify(existingFile, fileContent);
                new Notice(`Updated "${fileName}" with ${sortedTags.length} tags.`);
            } else {
                await this.app.vault.create(fileName, fileContent);
                new Notice(`Created "${fileName}" with ${sortedTags.length} tags.`);
            }
        } catch (e) {
            console.error('Failed to create tag list file:', e);
            new Notice('Failed to create tag list file.');
        }
    }

    // Rename a specific tag across the vault
    async renameTag(oldTag: string, newTag: string) {
        const files = this.app.vault.getMarkdownFiles();
        let processedCount = 0;

        // Remove leading # if user provided it
        let search = oldTag.startsWith('#') ? oldTag.substring(1) : oldTag;
        let replace = newTag.startsWith('#') ? newTag.substring(1) : newTag;

        if (!search || !replace) {
            new Notice('Please provide both old and new tags.');
            return;
        }

        new Notice(`Renaming #${search} to #${replace}...`);

        // Robust regex to match #Tag but NOT #Tag-Suffix (exact word or before slash)
        // Matches: #Tag, #Tag/Child
        // No Match: #TagSuffix
        // Escaping regex special chars in user input is important (simplified here assuming normal tag chars)
        const escapeRegExp = (string: string) => {
            return string.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        };
        const escapedSearch = escapeRegExp(search);

        // Regex explanation:
        // (^|\s) : Start of line or whitespace
        // (#) : The hash
        // (${escapedSearch}) : The tag name
        // (?=[\s\/]|$) : Lookahead ensures it ends with space, slash (nested), or end of string.
        const tagRegex = new RegExp(`(^|\\s)(#)(${escapedSearch})(?=[\\s\\/]|$|[^\\p{L}\\p{N}_-])`, 'gu');

        for (const file of files) {
            let modified = false;

            // 1. Process Frontmatter
            await this.app.fileManager.processFrontMatter(file, (frontmatter) => {
                const processSingleTag = (t: string): string => {
                    let hasHash = t.startsWith('#');
                    let raw = hasHash ? t.substring(1) : t;

                    // Exact match or Nested match
                    if (raw === search) {
                        modified = true;
                        return hasHash ? '#' + replace : replace;
                    } else if (raw.startsWith(search + '/')) {
                        modified = true;
                        // Replace prefix
                        let newRaw = replace + raw.substring(search.length);
                        return hasHash ? '#' + newRaw : newRaw;
                    }
                    return t;
                };

                if (frontmatter.tags) {
                    if (Array.isArray(frontmatter.tags)) {
                        frontmatter.tags = frontmatter.tags.map(processSingleTag);
                    } else if (typeof frontmatter.tags === 'string') {
                        frontmatter.tags = processSingleTag(frontmatter.tags);
                    }
                }
                if (frontmatter.tag) { // Alias
                    if (Array.isArray(frontmatter.tag)) {
                        frontmatter.tag = frontmatter.tag.map(processSingleTag);
                    } else if (typeof frontmatter.tag === 'string') {
                        frontmatter.tag = processSingleTag(frontmatter.tag);
                    }
                }
            });

            // 2. Process Body
            // If we modified frontmatter, file changes are verified.
            // Now check body.
            await this.app.vault.process(file, (data) => {
                const newData = data.replace(tagRegex, (match, prefix, hash, capturedTag) => {
                    // We found a match.
                    modified = true;
                    return prefix + hash + replace;
                });
                return newData;
            });

            if (modified) processedCount++;
        }

        new Notice(`Renamed in ${processedCount} files.`);
    }

    async processFile(file: TFile) {
        await this.app.fileManager.processFrontMatter(file, (frontmatter) => {
            const processSingleTag = (t: string): string => {
                let hasHash = t.startsWith('#');
                let clean = hasHash ? t.substring(1) : t;
                let converted = this.convertTagContent(clean);
                return hasHash ? '#' + converted : converted;
            };

            if (frontmatter.tags) {
                if (Array.isArray(frontmatter.tags)) {
                    frontmatter.tags = frontmatter.tags.map((t: string) => processSingleTag(t));
                } else if (typeof frontmatter.tags === 'string') {
                    frontmatter.tags = processSingleTag(frontmatter.tags);
                }
            }
            if (frontmatter.tag) {
                if (Array.isArray(frontmatter.tag)) {
                    frontmatter.tag = frontmatter.tag.map((t: string) => processSingleTag(t));
                } else if (typeof frontmatter.tag === 'string') {
                    frontmatter.tag = processSingleTag(frontmatter.tag);
                }
            }
        });

        await this.app.vault.process(file, (data) => {
            const tagRegex = /(^|\s)(#[\p{L}\p{N}_\-\/]+)/gu;
            return data.replace(tagRegex, (match, prefix, tag) => {
                let clean = tag.substring(1);
                let converted = this.convertTagContent(clean);
                return prefix + '#' + converted;
            });
        });
    }

    convertTagContent(tagContent: string): string {
        let parts = tagContent.split('/');
        let processedParts = parts.map((part, index) => {
            if (index > 0 && !this.settings.applyToNestedTags) {
                return part;
            }
            return this.transformSegment(part);
        });
        return processedParts.join('/');
    }

    transformSegment(segment: string): string {
        let s = segment;
        if (this.settings.removeSpecialChars) {
            s = s.replace(/[^\p{L}\p{N}\-_]/gu, '');
        }
        if (this.settings.separatorStrategy === 'snake') {
            s = s.replace(/-/g, '_');
        } else if (this.settings.separatorStrategy === 'kebab') {
            s = s.replace(/_/g, '-');
        }
        if (this.settings.caseStrategy === 'lowercase') {
            s = s.toLowerCase();
        } else if (this.settings.caseStrategy === 'uppercase') {
            s = s.toUpperCase();
        }
        return s;
    }
}

// --- Dashboard Modal ---

class TagManagerModal extends Modal {
    plugin: TagLowercasePlugin;
    statsEl: HTMLElement;
    findInput: TextComponent;
    replaceInput: TextComponent;

    constructor(app: App, plugin: TagLowercasePlugin) {
        super(app);
        this.plugin = plugin;
    }

    onOpen() {
        const { contentEl } = this;
        contentEl.empty();
        contentEl.createEl('h1', { text: 'Bulk Tag Manager' });

        // Stats Section
        this.statsEl = contentEl.createEl('div', { cls: 'tag-manager-stats' });
        this.updateStats();

        // NEW Renamer Section
        contentEl.createEl('hr');
        contentEl.createEl('h3', { text: 'Rename Specific Tag' });
        const renameContainer = contentEl.createEl('div', { cls: 'tag-manager-rename', attr: { style: 'display: flex; gap: 10px; align-items: flex-end;' } });

        const findDiv = renameContainer.createEl('div');
        findDiv.createEl('label', { text: 'Find (e.g. #typo)' });
        this.findInput = new TextComponent(findDiv).setPlaceholder('Old Tag');

        const replaceDiv = renameContainer.createEl('div');
        replaceDiv.createEl('label', { text: 'Replace (e.g. #fixed)' });
        this.replaceInput = new TextComponent(replaceDiv).setPlaceholder('New Tag');

        const btnRename = renameContainer.createEl('button', { text: 'Rename' });
        btnRename.onclick = async () => {
            const oldT = this.findInput.getValue();
            const newT = this.replaceInput.getValue();
            if (oldT && newT) {
                this.close();
                await this.plugin.renameTag(oldT, newT);
            } else {
                new Notice('Please fill both Find and Replace fields.');
            }
        };

        contentEl.createEl('hr');

        // Settings Section
        contentEl.createEl('h3', { text: 'Bulk Settings' });

        new Setting(contentEl)
            .setName('Case Strategy')
            .addDropdown(dropdown => dropdown
                .addOption('lowercase', 'Lowercase')
                .addOption('uppercase', 'Uppercase')
                .addOption('none', 'No Casing Change')
                .setValue(this.plugin.settings.caseStrategy)
                .onChange(async (value: any) => {
                    this.plugin.settings.caseStrategy = value;
                    await this.plugin.saveSettings();
                    this.updateStats();
                }));

        new Setting(contentEl)
            .setName('Separator Style')
            .addDropdown(dropdown => dropdown
                .addOption('preserve', 'Preserve')
                .addOption('snake', 'Snake Case (- to _)')
                .addOption('kebab', 'Kebab Case (_ to -)')
                .setValue(this.plugin.settings.separatorStrategy)
                .onChange(async (value: any) => {
                    this.plugin.settings.separatorStrategy = value;
                    await this.plugin.saveSettings();
                    this.updateStats();
                }));

        new Setting(contentEl)
            .setName('Remove Special Characters')
            .addToggle(toggle => toggle
                .setValue(this.plugin.settings.removeSpecialChars)
                .onChange(async (value) => {
                    this.plugin.settings.removeSpecialChars = value;
                    await this.plugin.saveSettings();
                    this.updateStats();
                }));

        new Setting(contentEl)
            .setName('Apply to Nested Tags')
            .addToggle(toggle => toggle
                .setValue(this.plugin.settings.applyToNestedTags)
                .onChange(async (value) => {
                    this.plugin.settings.applyToNestedTags = value;
                    await this.plugin.saveSettings();
                    this.updateStats();
                }));

        // Actions Section
        const actionDiv = contentEl.createEl('div', { cls: 'tag-manager-actions', attr: { style: 'margin-top: 20px; display: flex; gap: 10px;' } });

        const btnConvert = actionDiv.createEl('button', { text: 'Convert All Tags', cls: 'mod-cta' });
        btnConvert.onclick = async () => {
            this.close();
            await this.plugin.runConversion();
        };

        const btnList = actionDiv.createEl('button', { text: 'Generate Tag List' });
        btnList.onclick = async () => {
            this.close();
            await this.plugin.generateTagList();
        };
    }

    updateStats() {
        this.statsEl.empty();

        const allTags = this.plugin.app.metadataCache.getTags();
        const uniqueTags = allTags ? Object.keys(allTags) : [];
        const totalCount = uniqueTags.length;

        let affectedCount = 0;
        uniqueTags.forEach(tag => {
            const raw = tag.substring(1);
            const converted = this.plugin.convertTagContent(raw);
            if (raw !== converted) {
                affectedCount++;
            }
        });

        this.statsEl.createEl('div', { text: `Total Unique Tags: ${totalCount}` });
        this.statsEl.createEl('div', { text: `Tags to be Updated (Bulk): ${affectedCount}`, attr: { style: 'font-weight: bold; color: var(--text-accent);' } });
    }

    onClose() {
        const { contentEl } = this;
        contentEl.empty();
    }
}

// --- Settings Tab ---
class TagLowercaseSettingTab extends PluginSettingTab {
    plugin: TagLowercasePlugin;

    constructor(app: App, plugin: TagLowercasePlugin) {
        super(app, plugin);
        this.plugin = plugin;
    }

    display(): void {
        const { containerEl } = this;
        containerEl.empty();
        containerEl.createEl('h2', { text: 'Tag Conversion Settings' });
        containerEl.createEl('p', { text: 'You can also access these settings and run actions via the Ribbon Icon dashboard.' });

        new Setting(containerEl)
            .setName('Case Strategy')
            .addDropdown(dropdown => dropdown
                .addOption('lowercase', 'Lowercase')
                .addOption('uppercase', 'Uppercase')
                .addOption('none', 'No Change')
                .setValue(this.plugin.settings.caseStrategy)
                .onChange(async (value: any) => {
                    this.plugin.settings.caseStrategy = value;
                    await this.plugin.saveSettings();
                }));

        new Setting(containerEl)
            .setName('Separator Style')
            .addDropdown(dropdown => dropdown
                .addOption('preserve', 'Preserve')
                .addOption('snake', 'Snake Case')
                .addOption('kebab', 'Kebab Case')
                .setValue(this.plugin.settings.separatorStrategy)
                .onChange(async (value: any) => {
                    this.plugin.settings.separatorStrategy = value;
                    await this.plugin.saveSettings();
                }));

        new Setting(containerEl)
            .setName('Remove Special Characters')
            .addToggle(toggle => toggle
                .setValue(this.plugin.settings.removeSpecialChars)
                .onChange(async (value) => {
                    this.plugin.settings.removeSpecialChars = value;
                    await this.plugin.saveSettings();
                }));

        new Setting(containerEl)
            .setName('Apply to Nested Tags')
            .addToggle(toggle => toggle
                .setValue(this.plugin.settings.applyToNestedTags)
                .onChange(async (value) => {
                    this.plugin.settings.applyToNestedTags = value;
                    await this.plugin.saveSettings();
                }));
    }
}

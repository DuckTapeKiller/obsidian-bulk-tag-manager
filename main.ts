import { App, Modal, Notice, Plugin, PluginSettingTab, Setting, TFile, TextComponent, SuggestModal, TFolder, setIcon, setTooltip } from 'obsidian';

// --- Interfaces ---

interface OperationRecord {
    id: string;
    type: 'rename' | 'merge' | 'convert' | 'pattern';
    timestamp: number;
    description: string;
    changes: FileChange[];
}

interface FileChange {
    path: string;
    before: string;
    after: string;
}

interface PreviewResult {
    affectedFiles: PreviewFile[];
    totalChanges: number;
}

interface PreviewFile {
    path: string;
    changes: { line: number; before: string; after: string }[];
    included: boolean;
}

interface TagNode {
    name: string;
    fullPath: string;
    count: number;
    children: TagNode[];
}

interface ScopeFilter {
    enabled: boolean;
    includeFolders: string[];
    excludeFolders: string[];
    filePattern: string;
}

interface TagStandardizationStats {
    totalTags: number;
    caseStats: {
        lowercase: string[];
        uppercase: string[];
        mixed: string[];
        consistency: number;
    };
    separatorStats: {
        underscore: string[];
        hyphen: string[];
        both: string[];
        none: string[];
        consistency: number;
    };
    specialCharStats: {
        withSpecial: string[];
        clean: string[];
        consistency: number;
    };
    nestingStats: {
        nested: string[];
        flat: string[];
        maxDepth: number;
    };
    lengthStats: {
        short: string[];
        medium: string[];
        long: string[];
        avgLength: number;
    };
    locationStats: {
        frontmatter: string[];
        body: string[];
    };

    inlineFiles: { file: TFile; count: number; tags: string[] }[];
    nestedFiles: { file: TFile; count: number; tags: string[] }[];
}

interface InvalidTagFile {
    path: string;
    file: TFile;
    issues: string[];
}

interface TagLowercaseSettings {
    caseStrategy: 'lowercase' | 'uppercase' | 'none';
    separatorStrategy: 'preserve' | 'snake' | 'kebab';
    removeSpecialChars: boolean;
    applyToNestedTags: boolean;
    tagFormat: 'inline' | 'list';
    aliases: Record<string, string>;
    operationHistory: OperationRecord[];
    scopeFilter: ScopeFilter;
    orphanThreshold: number;
    maxHistorySize: number;
}

const DEFAULT_SETTINGS: TagLowercaseSettings = {
    caseStrategy: 'lowercase',
    separatorStrategy: 'preserve',
    removeSpecialChars: false,
    applyToNestedTags: true,
    tagFormat: 'inline',
    aliases: {},
    operationHistory: [],
    scopeFilter: {
        enabled: false,
        includeFolders: [],
        excludeFolders: [],
        filePattern: ''
    },
    orphanThreshold: 2,
    maxHistorySize: 50
};

// Improved regex that skips code blocks
const TAG_REGEX = /(^|\s)(#[\p{L}\p{N}_\-\/]+)/gu;

export default class TagLowercasePlugin extends Plugin {
    settings: TagLowercaseSettings;

    async onload() {
        await this.loadSettings();

        this.addRibbonIcon('tags', 'Bulk Tag Manager', () => {
            new TagManagerModal(this.app, this).open();
        });

        this.addCommand({
            id: 'open-tag-manager',
            name: 'Open Tag Manager Dashboard',
            callback: () => new TagManagerModal(this.app, this).open()
        });

        this.addCommand({
            id: 'convert-all-tags',
            name: 'Convert all tags (with preview)',
            callback: () => this.runConversionWithPreview()
        });

        this.addCommand({
            id: 'generate-tag-list',
            name: 'Generate Tag List',
            callback: () => this.generateTagList()
        });

        this.addCommand({
            id: 'show-tag-hierarchy',
            name: 'Show Tag Hierarchy',
            callback: () => new TagHierarchyModal(this.app, this).open()
        });

        this.addCommand({
            id: 'find-orphan-tags',
            name: 'Find Orphaned Tags',
            callback: () => new OrphanTagsModal(this.app, this).open()
        });

        this.addCommand({
            id: 'undo-last-operation',
            name: 'Undo Last Tag Operation',
            callback: () => this.undoLastOperation()
        });

        this.addSettingTab(new TagLowercaseSettingTab(this.app, this));

        // Register event for alias auto-correction
        this.registerEvent(
            this.app.vault.on('modify', (file) => {
                if (file instanceof TFile && Object.keys(this.settings.aliases).length > 0) {
                    this.applyAliasesDebounced(file);
                }
            })
        );
    }

    private aliasDebounceTimer: ReturnType<typeof setTimeout> | null = null;

    applyAliasesDebounced(file: TFile) {
        if (this.aliasDebounceTimer) clearTimeout(this.aliasDebounceTimer);
        this.aliasDebounceTimer = setTimeout(() => this.applyAliases(file), 1000);
    }

    async loadSettings() {
        this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
    }

    async saveSettings() {
        await this.saveData(this.settings);
    }

    // --- File Filtering ---

    getFilteredFiles(): TFile[] {
        let files = this.app.vault.getMarkdownFiles();

        if (!this.settings.scopeFilter.enabled) return files;

        const { includeFolders, excludeFolders, filePattern } = this.settings.scopeFilter;

        if (includeFolders.length > 0) {
            files = files.filter(f => includeFolders.some(folder => f.path.startsWith(folder)));
        }

        if (excludeFolders.length > 0) {
            files = files.filter(f => !excludeFolders.some(folder => f.path.startsWith(folder)));
        }

        if (filePattern) {
            try {
                const regex = new RegExp(filePattern);
                files = files.filter(f => regex.test(f.path));
            } catch { /* invalid regex, ignore */ }
        }

        return files;
    }

    // --- History Management ---

    async addToHistory(record: Omit<OperationRecord, 'id' | 'timestamp'>) {
        const fullRecord: OperationRecord = {
            ...record,
            id: crypto.randomUUID(),
            timestamp: Date.now()
        };

        this.settings.operationHistory.unshift(fullRecord);

        if (this.settings.operationHistory.length > this.settings.maxHistorySize) {
            this.settings.operationHistory = this.settings.operationHistory.slice(0, this.settings.maxHistorySize);
        }

        await this.saveSettings();
    }

    async undoLastOperation() {
        if (this.settings.operationHistory.length === 0) {
            new Notice('No operations to undo.');
            return;
        }

        const lastOp = this.settings.operationHistory[0];
        let revertedCount = 0;

        new Notice(`Reverting: ${lastOp.description}...`);

        for (const change of lastOp.changes) {
            const file = this.app.vault.getAbstractFileByPath(change.path);
            if (file instanceof TFile) {
                try {
                    await this.app.vault.modify(file, change.before);
                    revertedCount++;
                } catch (e) {
                    console.error(`Failed to revert ${change.path}:`, e);
                }
            }
        }

        this.settings.operationHistory.shift();
        await this.saveSettings();

        new Notice(`Reverted ${revertedCount} files.`);
    }

    // --- Preview System ---

    async previewConversion(): Promise<PreviewResult> {
        const files = this.getFilteredFiles();
        const affectedFiles: PreviewFile[] = [];

        for (const file of files) {
            const content = await this.app.vault.read(file);
            const newContent = this.transformContent(content);

            if (content !== newContent) {
                const changes = this.diffContent(content, newContent);
                affectedFiles.push({ path: file.path, changes, included: true });
            }
        }

        return {
            affectedFiles,
            totalChanges: affectedFiles.reduce((sum, f) => sum + f.changes.length, 0)
        };
    }

    private diffContent(before: string, after: string): { line: number; before: string; after: string }[] {
        const beforeLines = before.split('\n');
        const afterLines = after.split('\n');
        const changes: { line: number; before: string; after: string }[] = [];

        for (let i = 0; i < Math.max(beforeLines.length, afterLines.length); i++) {
            if (beforeLines[i] !== afterLines[i]) {
                changes.push({ line: i + 1, before: beforeLines[i] || '', after: afterLines[i] || '' });
            }
        }

        return changes;
    }

    private transformContent(content: string): string {
        // Skip code blocks
        const codeBlockRegex = /```[\s\S]*?```|`[^`\n]+`/g;
        const codeBlocks: { start: number; end: number }[] = [];
        let match;

        while ((match = codeBlockRegex.exec(content)) !== null) {
            codeBlocks.push({ start: match.index, end: match.index + match[0].length });
        }

        return content.replace(TAG_REGEX, (fullMatch, prefix, tag, offset) => {
            // Check if inside code block
            if (codeBlocks.some(b => offset >= b.start && offset < b.end)) {
                return fullMatch;
            }

            const clean = tag.substring(1);
            const converted = this.convertTagContent(clean);
            return prefix + '#' + converted;
        });
    }

    async runConversionWithPreview() {
        const preview = await this.previewConversion();

        if (preview.affectedFiles.length === 0) {
            new Notice('No tags need conversion.');
            return;
        }

        new PreviewModal(this.app, this, preview, async (selectedFiles) => {
            await this.executeConversion(selectedFiles);
        }).open();
    }

    async executeConversion(files: PreviewFile[]) {
        const changes: FileChange[] = [];
        let processedCount = 0;

        const progressModal = new ProgressModal(this.app, files.length);
        progressModal.open();

        for (const previewFile of files) {
            if (!previewFile.included) continue;

            const file = this.app.vault.getAbstractFileByPath(previewFile.path);
            if (!(file instanceof TFile)) continue;

            try {
                const before = await this.app.vault.read(file);
                await this.processFile(file);
                const after = await this.app.vault.read(file);

                if (before !== after) {
                    changes.push({ path: file.path, before, after });
                }

                processedCount++;
                progressModal.update(processedCount);
            } catch (e) {
                console.error(`Failed to process ${file.path}:`, e);
            }
        }

        progressModal.close();

        if (changes.length > 0) {
            await this.addToHistory({
                type: 'convert',
                description: `Bulk conversion (${changes.length} files)`,
                changes
            });
        }

        new Notice(`Converted tags in ${processedCount} files.`);
    }

    // --- Tag Operations ---

    async runConversion() {
        const files = this.getFilteredFiles();
        const changes: FileChange[] = [];
        let processedCount = 0;

        const progressModal = new ProgressModal(this.app, files.length);
        progressModal.open();

        for (const file of files) {
            try {
                const before = await this.app.vault.read(file);
                await this.processFile(file);
                const after = await this.app.vault.read(file);

                if (before !== after) {
                    changes.push({ path: file.path, before, after });
                }

                processedCount++;
                progressModal.update(processedCount);
            } catch (e) {
                console.error(`Failed to process ${file.path}:`, e);
            }
        }

        progressModal.close();

        if (changes.length > 0) {
            await this.addToHistory({
                type: 'convert',
                description: `Bulk conversion (${changes.length} files)`,
                changes
            });
        }

        new Notice(`Processed ${processedCount} files.`);
    }

    async generateTagList() {
        const tags = this.app.metadataCache.getTags();
        if (!tags || Object.keys(tags).length === 0) {
            new Notice('No tags found in vault.');
            return;
        }

        const sortedTags = Object.keys(tags)
            .sort((a, b) => a.localeCompare(b));

        const fileContent = `# All Tags\n\n${sortedTags.join('\n')}\n`;
        const fileName = 'All Tags.md';

        try {
            const existingFile = this.app.vault.getAbstractFileByPath(fileName);
            if (existingFile instanceof TFile) {
                await this.app.vault.modify(existingFile, fileContent);
            } else {
                await this.app.vault.create(fileName, fileContent);
            }
            new Notice(`Created "${fileName}" with ${sortedTags.length} tags.`);
        } catch (e) {
            console.error('Failed to create tag list:', e);
            new Notice('Failed to create tag list file.');
        }
    }

    async renameTag(oldTag: string, newTag: string) {
        const files = this.getFilteredFiles();
        const changes: FileChange[] = [];

        const search = oldTag.startsWith('#') ? oldTag.substring(1) : oldTag;
        const replace = newTag.startsWith('#') ? newTag.substring(1) : newTag;

        if (!search || !replace) {
            new Notice('Please provide both old and new tags.');
            return;
        }

        new Notice(`Scanning for #${search}...`);

        const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const escapedSearch = escapeRegExp(search);
        const tagRegex = new RegExp(`(^|\\s)(#)(${escapedSearch})(?=[\\s\\/]|$|[^\\p{L}\\p{N}_-])`, 'gu');

        // First pass: find files that contain the tag
        const matchingFiles: TFile[] = [];
        for (const file of files) {
            const content = await this.app.vault.read(file);
            const cache = this.app.metadataCache.getFileCache(file);

            // Check frontmatter tags
            let hasFrontmatterTag = false;
            if (cache?.frontmatter?.tags) {
                const fmTags = Array.isArray(cache.frontmatter.tags)
                    ? cache.frontmatter.tags
                    : [cache.frontmatter.tags];
                hasFrontmatterTag = fmTags.some((t: string) => {
                    const raw = t.startsWith('#') ? t.substring(1) : t;
                    return raw === search || raw.startsWith(search + '/');
                });
            }
            if (cache?.frontmatter?.tag) {
                const fmTags = Array.isArray(cache.frontmatter.tag)
                    ? cache.frontmatter.tag
                    : [cache.frontmatter.tag];
                hasFrontmatterTag = hasFrontmatterTag || fmTags.some((t: string) => {
                    const raw = t.startsWith('#') ? t.substring(1) : t;
                    return raw === search || raw.startsWith(search + '/');
                });
            }

            // Check inline tags
            const hasInlineTag = tagRegex.test(content);
            tagRegex.lastIndex = 0; // Reset regex state

            if (hasFrontmatterTag || hasInlineTag) {
                matchingFiles.push(file);
            }
        }

        if (matchingFiles.length === 0) {
            new Notice(`No files found containing #${search}`);
            return;
        }

        new Notice(`Found ${matchingFiles.length} files with #${search}. Renaming...`);

        const progressModal = new ProgressModal(this.app, matchingFiles.length);
        progressModal.open();

        let processedCount = 0;

        for (const file of matchingFiles) {
            try {
                const before = await this.app.vault.read(file);
                let modified = false;

                await this.app.fileManager.processFrontMatter(file, (fm) => {
                    const processSingleTag = (t: string): string => {
                        const hasHash = t.startsWith('#');
                        const raw = hasHash ? t.substring(1) : t;
                        if (raw === search) {
                            modified = true;
                            return hasHash ? '#' + replace : replace;
                        } else if (raw.startsWith(search + '/')) {
                            modified = true;
                            const newRaw = replace + raw.substring(search.length);
                            return hasHash ? '#' + newRaw : newRaw;
                        }
                        return t;
                    };

                    if (fm.tags) {
                        if (Array.isArray(fm.tags)) {
                            fm.tags = fm.tags.map(processSingleTag);
                        } else if (typeof fm.tags === 'string') {
                            fm.tags = processSingleTag(fm.tags);
                        }
                    }
                    if (fm.tag) {
                        if (Array.isArray(fm.tag)) {
                            fm.tag = fm.tag.map(processSingleTag);
                        } else if (typeof fm.tag === 'string') {
                            fm.tag = processSingleTag(fm.tag);
                        }
                    }
                });

                await this.app.vault.process(file, (data) => {
                    const newData = data.replace(tagRegex, (m, prefix, hash) => {
                        modified = true;
                        return prefix + hash + replace;
                    });
                    tagRegex.lastIndex = 0; // Reset regex state
                    return newData;
                });

                if (modified) {
                    const after = await this.app.vault.read(file);
                    changes.push({ path: file.path, before, after });
                }

                processedCount++;
                progressModal.update(processedCount);
            } catch (e) {
                console.error(`Failed to process ${file.path}:`, e);
                processedCount++;
                progressModal.update(processedCount);
            }
        }

        progressModal.close();

        if (changes.length > 0) {
            await this.addToHistory({
                type: 'rename',
                description: `Rename #${search} → #${replace}`,
                changes
            });
        }

        new Notice(`Renamed #${search} → #${replace} in ${changes.length} files.`);
    }


    async mergeTags(sources: string[], target: string) {
        const targetClean = target.startsWith('#') ? target.substring(1) : target;
        const sourcesClean = sources
            .map(s => s.startsWith('#') ? s.substring(1) : s)
            .filter(s => s && s !== targetClean);

        if (sourcesClean.length === 0) {
            new Notice('No valid source tags to merge.');
            return;
        }

        new Notice(`Merging ${sourcesClean.length} tags into #${targetClean}...`);

        const files = this.getFilteredFiles();
        const changes: FileChange[] = [];

        const progressModal = new ProgressModal(this.app, files.length);
        progressModal.open();

        let processedCount = 0;

        // Build regex that matches any of the source tags
        const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const sourcePatterns = sourcesClean.map(s => escapeRegExp(s)).join('|');
        const tagRegex = new RegExp(`(^|\\s)(#)(${sourcePatterns})(?=[\\s\\/]|$|[^\\p{L}\\p{N}_-])`, 'gu');

        for (const file of files) {
            try {
                const before = await this.app.vault.read(file);
                let modified = false;

                // Process frontmatter tags
                await this.app.fileManager.processFrontMatter(file, (fm) => {
                    const processSingleTag = (t: string): string => {
                        const hasHash = t.startsWith('#');
                        const raw = hasHash ? t.substring(1) : t;

                        for (const source of sourcesClean) {
                            if (raw === source) {
                                modified = true;
                                return hasHash ? '#' + targetClean : targetClean;
                            }
                            if (raw.startsWith(source + '/')) {
                                modified = true;
                                const newRaw = targetClean + raw.substring(source.length);
                                return hasHash ? '#' + newRaw : newRaw;
                            }
                        }
                        return t;
                    };

                    if (fm.tags) {
                        if (Array.isArray(fm.tags)) {
                            fm.tags = fm.tags.map(processSingleTag);
                        } else if (typeof fm.tags === 'string') {
                            fm.tags = processSingleTag(fm.tags);
                        }
                    }
                    if (fm.tag) {
                        if (Array.isArray(fm.tag)) {
                            fm.tag = fm.tag.map(processSingleTag);
                        } else if (typeof fm.tag === 'string') {
                            fm.tag = processSingleTag(fm.tag);
                        }
                    }
                });

                // Process inline tags
                await this.app.vault.process(file, (data) => {
                    const newData = data.replace(tagRegex, (match, prefix, hash, capturedTag) => {
                        // Find which source tag matched and replace with target
                        for (const source of sourcesClean) {
                            if (capturedTag === source || capturedTag.startsWith(source + '/')) {
                                modified = true;
                                if (capturedTag === source) {
                                    return prefix + hash + targetClean;
                                } else {
                                    // Nested tag: replace prefix
                                    return prefix + hash + targetClean + capturedTag.substring(source.length);
                                }
                            }
                        }
                        return match;
                    });
                    tagRegex.lastIndex = 0;
                    return newData;
                });

                if (modified) {
                    const after = await this.app.vault.read(file);
                    changes.push({ path: file.path, before, after });
                }

                processedCount++;
                progressModal.update(processedCount);
            } catch (e) {
                console.error(`Failed to process ${file.path}:`, e);
                processedCount++;
                progressModal.update(processedCount);
            }
        }

        progressModal.close();

        if (changes.length > 0) {
            await this.addToHistory({
                type: 'merge',
                description: `Merge ${sourcesClean.map(s => '#' + s).join(', ')} → #${targetClean}`,
                changes
            });
        }

        new Notice(`Merged ${sourcesClean.length} tags into #${targetClean}. ${changes.length} files changed.`);
    }

    async batchRename(pattern: string, replacement: string) {
        const files = this.getFilteredFiles();
        const changes: FileChange[] = [];
        let regex: RegExp;

        try {
            regex = new RegExp(pattern, 'g');
        } catch {
            new Notice('Invalid regex pattern.');
            return;
        }

        const progressModal = new ProgressModal(this.app, files.length);
        progressModal.open();

        let processedCount = 0;

        for (const file of files) {
            const before = await this.app.vault.read(file);

            await this.app.vault.process(file, (data) => {
                return data.replace(TAG_REGEX, (fullMatch, prefix, tag) => {
                    const clean = tag.substring(1);
                    const newTag = clean.replace(regex, replacement);
                    if (newTag !== clean) {
                        return prefix + '#' + newTag;
                    }
                    return fullMatch;
                });
            });

            const after = await this.app.vault.read(file);
            if (before !== after) {
                changes.push({ path: file.path, before, after });
            }

            processedCount++;
            progressModal.update(processedCount);
        }

        progressModal.close();

        if (changes.length > 0) {
            await this.addToHistory({
                type: 'pattern',
                description: `Pattern: /${pattern}/ → ${replacement}`,
                changes
            });
        }

        new Notice(`Pattern rename affected ${changes.length} files.`);
    }

    // --- Tag Analysis ---

    getTagHierarchy(): TagNode[] {
        const tags = this.app.metadataCache.getTags() || {};
        const root: TagNode[] = [];

        for (const [tag, count] of Object.entries(tags)) {
            const parts = tag.substring(1).split('/');
            let currentLevel = root;
            let currentPath = '';

            for (let i = 0; i < parts.length; i++) {
                const part = parts[i];
                currentPath = currentPath ? `${currentPath}/${part}` : part;

                let existingNode = currentLevel.find(n => n.name === part);

                if (!existingNode) {
                    existingNode = { name: part, fullPath: currentPath, count: 0, children: [] };
                    currentLevel.push(existingNode);
                }

                if (i === parts.length - 1) {
                    existingNode.count = count;
                }

                currentLevel = existingNode.children;
            }
        }

        return root;
    }

    findOrphanedTags(): { tag: string; count: number }[] {
        const tags = this.app.metadataCache.getTags() || {};
        return Object.entries(tags)
            .filter(([, count]) => count < this.settings.orphanThreshold)
            .map(([tag, count]) => ({ tag, count: count as number }))
            .sort((a, b) => a.count - b.count);
    }

    analyzeTagStandardization(files: TFile[]): TagStandardizationStats {
        const tags = Object.keys(this.app.metadataCache.getTags() || {});
        const totalTags = tags.length;

        // Initialize arrays
        const stats: TagStandardizationStats = {
            totalTags,
            caseStats: { lowercase: [], uppercase: [], mixed: [], consistency: 100 },
            separatorStats: { underscore: [], hyphen: [], both: [], none: [], consistency: 100 },
            specialCharStats: { withSpecial: [], clean: [], consistency: 100 },
            nestingStats: { nested: [], flat: [], maxDepth: 0 },
            lengthStats: { short: [], medium: [], long: [], avgLength: 0 },
            locationStats: { frontmatter: [], body: [] },
            inlineFiles: [],
            nestedFiles: []
        };

        if (totalTags === 0) return stats;

        // 1. Analyze Tag Strings (Global)
        let totalLength = 0;

        for (const tag of tags) {
            const rawTag = tag.startsWith('#') ? tag.substring(1) : tag;

            // Case check
            const letters = rawTag.replace(/[^a-zA-Z]/g, '');
            if (letters.length > 0) {
                const isAllLower = letters === letters.toLowerCase();
                const isAllUpper = letters === letters.toUpperCase();
                if (isAllLower && !isAllUpper) stats.caseStats.lowercase.push(tag);
                else if (isAllUpper && !isAllLower) stats.caseStats.uppercase.push(tag);
                else stats.caseStats.mixed.push(tag);
            } else {
                stats.caseStats.lowercase.push(tag); // Default
            }

            // Separator check
            const hasUnderscore = rawTag.includes('_');
            const hasHyphen = rawTag.includes('-');
            if (hasUnderscore && hasHyphen) stats.separatorStats.both.push(tag);
            else if (hasUnderscore) stats.separatorStats.underscore.push(tag);
            else if (hasHyphen) stats.separatorStats.hyphen.push(tag);
            else stats.separatorStats.none.push(tag);

            // Special char check
            const hasSpecial = /[^a-zA-Z0-9_\-\/]/.test(rawTag);
            if (hasSpecial) stats.specialCharStats.withSpecial.push(tag);
            else stats.specialCharStats.clean.push(tag);

            // Nesting check
            const depth = (rawTag.match(/\//g) || []).length + 1;
            if (depth > 1) stats.nestingStats.nested.push(tag);
            else stats.nestingStats.flat.push(tag);
            stats.nestingStats.maxDepth = Math.max(stats.nestingStats.maxDepth, depth);

            // Length check
            totalLength += rawTag.length;
            if (rawTag.length <= 10) stats.lengthStats.short.push(tag);
            else if (rawTag.length <= 25) stats.lengthStats.medium.push(tag);
            else stats.lengthStats.long.push(tag);
        }

        // 2. Analyze Location (Frontmatter vs Body)
        // Use Sets to count unique tags in each location
        const fmTags = new Set<string>();
        const bodyTags = new Set<string>();

        // We iterate files which is safer for determining current usages
        for (const file of files) {
            const cache = this.app.metadataCache.getFileCache(file);
            if (!cache) continue;

            const fileInlineSet = new Set<string>();
            const fileNestedSet = new Set<string>();

            // Frontmatter
            const fm = cache.frontmatter;
            if (fm) {
                let list: string[] = [];
                if (fm.tags) {
                    if (typeof fm.tags === 'string') list = fm.tags.split(',').map(t => t.trim());
                    else if (Array.isArray(fm.tags)) list = fm.tags.map(t => String(t));
                }
                if (fm.tag) {
                    if (typeof fm.tag === 'string') list = list.concat([fm.tag]);
                    else if (Array.isArray(fm.tag)) list = list.concat(fm.tag.map(t => String(t)));
                }

                list.forEach(t => {
                    const clean = t.startsWith('#') ? t.substring(1) : t;
                    fmTags.add(clean);
                    if (clean.includes('/')) fileNestedSet.add(clean);
                });
            }

            // Body (Inline Tags)
            if (cache.tags) {
                cache.tags.forEach(t => {
                    const clean = t.tag.startsWith('#') ? t.tag.substring(1) : t.tag;
                    bodyTags.add(clean);
                    fileInlineSet.add(clean);
                    if (clean.includes('/')) fileNestedSet.add(clean);
                });
            }

            if (fileInlineSet.size > 0) {
                stats.inlineFiles.push({
                    file,
                    count: fileInlineSet.size,
                    tags: Array.from(fileInlineSet).sort()
                });
            }

            if (fileNestedSet.size > 0) {
                stats.nestedFiles.push({
                    file,
                    count: fileNestedSet.size,
                    tags: Array.from(fileNestedSet).sort()
                });
            }
        }

        stats.locationStats.frontmatter = Array.from(fmTags).sort();
        stats.locationStats.body = Array.from(bodyTags).sort();

        // Calculate Average
        stats.lengthStats.avgLength = Math.round(totalLength / totalTags);

        // Calculate Consistencies
        const calcConsistency = (arrays: string[][]) => {
            const dominant = Math.max(...arrays.map(a => a.length));
            return Math.round((dominant / totalTags) * 100);
        };

        stats.caseStats.consistency = calcConsistency([stats.caseStats.lowercase, stats.caseStats.uppercase, stats.caseStats.mixed]);

        // For separators
        const sepArrays = [stats.separatorStats.underscore, stats.separatorStats.hyphen, stats.separatorStats.none];
        const dominantSep = Math.max(...sepArrays.map(a => a.length));
        stats.separatorStats.consistency = Math.round(((dominantSep + (stats.separatorStats.both.length === 0 ? 0 : 0)) / totalTags) * 100);

        stats.specialCharStats.consistency = Math.round((stats.specialCharStats.clean.length / totalTags) * 100);

        return stats;
    }


    async findInvalidTagFormats(): Promise<InvalidTagFile[]> {
        const invalidFiles: InvalidTagFile[] = [];
        const files = this.getFilteredFiles();

        for (const file of files) {
            // Use MetadataCache for performance and accuracy
            const cache = this.app.metadataCache.getFileCache(file);
            if (!cache?.frontmatter) continue;

            const issues: string[] = [];
            const fm = cache.frontmatter;

            // Helper to check a key
            const checkKey = (key: string, value: any) => {
                if (value === undefined || value === null) return;

                if (typeof value === 'string') {
                    // Check for comma-separated
                    if (value.includes(',')) {
                        issues.push(`"${key}" uses comma-separated format instead of YAML array`);
                    } else if (value.trim().length > 0 && value.trim().includes(' ')) {
                        issues.push(`"${key}" contains spaces - may be invalid`);
                    }
                } else if (Array.isArray(value)) {
                    // Check elements
                    value.forEach(t => {
                        if (typeof t === 'string' && t.trim().includes(' ')) {
                            issues.push(`Tag "${t}" contains spaces`);
                        }
                    });
                }
            };

            if ('tags' in fm) checkKey('tags', fm.tags);
            if ('tag' in fm) checkKey('tag', fm.tag);

            if (issues.length > 0) {
                invalidFiles.push({
                    path: file.path,
                    file: file,
                    issues: issues
                });
            }
        }

        return invalidFiles;
    }

    async findEmptyTags(): Promise<TFile[]> {
        const emptyFiles: TFile[] = [];
        const files = this.getFilteredFiles();

        for (const file of files) {
            const cache = this.app.metadataCache.getFileCache(file);
            if (!cache?.frontmatter) continue;
            const fm = cache.frontmatter;

            // Check if 'tags' key exists but result is empty/null
            if ('tags' in fm) {
                const val = fm.tags;
                if (val === null || val === undefined || (Array.isArray(val) && val.length === 0)) {
                    emptyFiles.push(file);
                }
            }
        }
        return emptyFiles;
    }

    async fixAndStandardizeTags(file: TFile): Promise<boolean> {
        let modified = false;

        // 1. Data Normalization (Fix broken formats)
        await this.app.fileManager.processFrontMatter(file, (fm) => {
            if (fm.tags) {
                if (typeof fm.tags === 'string') {
                    // Handle "a, b, c" format
                    fm.tags = fm.tags.split(',').map((t: string) => t.trim()).filter((t: string) => t.length > 0);
                    modified = true;
                }
            }
        });

        // 2. Format Standardization (Inline vs List)
        if (this.settings.tagFormat === 'inline') {
            // Read file and enforce inline format
            const content = await this.app.vault.read(file);
            const fmMatch = content.match(/^---\n([\s\S]*?)\n---/);
            if (fmMatch) {
                const originalFm = fmMatch[1];
                // Check if tags are in list format
                const listPattern = /^(tags?):\s*(?:\n\s*-.*)+/m;
                if (listPattern.test(originalFm)) {
                    // Check metadata for values
                    const cache = this.app.metadataCache.getFileCache(file);
                    const tags = cache?.frontmatter?.tags;

                    if (Array.isArray(tags)) {
                        const inlineString = `tags: [${tags.join(', ')}]`;
                        const newFm = originalFm.replace(listPattern, inlineString);
                        const newContent = content.replace(originalFm, newFm);
                        if (newContent !== content) {
                            await this.app.vault.modify(file, newContent);
                            modified = true;
                        }
                    }
                }
            }
        }

        return modified;
    }

    async standardizeAllTags() {
        const files = this.getFilteredFiles();
        if (files.length === 0) {
            new Notice('No files to standardize.');
            return;
        }

        const progressModal = new ProgressModal(this.app, files.length);
        progressModal.open();

        let count = 0;
        let modifiedCount = 0;

        for (const file of files) {
            try {
                // We run fixAndStandardizeTags.
                // Note: it reads/writes file, so it's a bit slow.
                await this.fixAndStandardizeTags(file);
                // We can't easily track "modified" here accurately
                // because fixAndStandardizeTags uses promises and maybe 2 writes.
                // But it's fine.
                modifiedCount++;
                count++;
                progressModal.update(count);
            } catch (e) {
                console.error(`Failed to standardize ${file.path}`, e);
            }
        }

        progressModal.close();
        new Notice(`Standardization check complete on ${count} files.`);
        // Refresh stats
        // We need a callback or event?
        // This method is called from Modal, which closes anyway.
    }

    // --- Aliases ---

    async applyAliases(file: TFile) {
        const aliases = this.settings.aliases;
        if (Object.keys(aliases).length === 0) return;

        let modified = false;

        await this.app.fileManager.processFrontMatter(file, (fm) => {
            const processSingleTag = (t: string): string => {
                const hasHash = t.startsWith('#');
                const raw = hasHash ? t.substring(1) : t;
                if (aliases[raw]) {
                    modified = true;
                    return hasHash ? '#' + aliases[raw] : aliases[raw];
                }
                return t;
            };

            if (fm.tags) {
                fm.tags = Array.isArray(fm.tags) ? fm.tags.map(processSingleTag) : processSingleTag(fm.tags);
            }
            if (fm.tag) {
                fm.tag = Array.isArray(fm.tag) ? fm.tag.map(processSingleTag) : processSingleTag(fm.tag);
            }
        });

        if (modified) {
            // Also process body
            for (const [alias, canonical] of Object.entries(aliases)) {
                const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
                const regex = new RegExp(`(^|\\s)(#)(${escapeRegExp(alias)})(?=[\\s\\/]|$)`, 'gu');

                await this.app.vault.process(file, (data) =>
                    data.replace(regex, (m, prefix, hash) => prefix + hash + canonical)
                );
            }
        }
    }

    // --- Core Processing ---

    async processFile(file: TFile) {
        await this.app.fileManager.processFrontMatter(file, (fm) => {
            const processSingleTag = (t: string): string => {
                const hasHash = t.startsWith('#');
                const clean = hasHash ? t.substring(1) : t;
                const converted = this.convertTagContent(clean);
                return hasHash ? '#' + converted : converted;
            };

            if (fm.tags) {
                fm.tags = Array.isArray(fm.tags) ? fm.tags.map(processSingleTag) : processSingleTag(fm.tags);
            }
            if (fm.tag) {
                fm.tag = Array.isArray(fm.tag) ? fm.tag.map(processSingleTag) : processSingleTag(fm.tag);
            }
        });

        await this.app.vault.process(file, (data) => this.transformContent(data));
    }

    convertTagContent(tagContent: string): string {
        const parts = tagContent.split('/');
        const processedParts = parts.map((part, index) => {
            if (index > 0 && !this.settings.applyToNestedTags) return part;
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

    getAllTags(): string[] {
        const tags = this.app.metadataCache.getTags() || {};
        return Object.keys(tags).map(t => t.substring(1)).sort();
    }
}
// --- Modal Components ---

// Progress Modal
class ProgressModal extends Modal {
    private total: number;
    private progressBar: HTMLElement;
    private progressText: HTMLElement;

    constructor(app: App, total: number) {
        super(app);
        this.total = total;
    }

    onOpen() {
        const { contentEl } = this;
        contentEl.empty();
        contentEl.addClass('btm-progress-modal');

        new Setting(contentEl).setName('Processing...').setHeading();

        const container = contentEl.createDiv({ cls: 'btm-progress-container' });
        this.progressBar = container.createDiv({ cls: 'btm-progress-bar' });
        this.progressBar.createDiv({ cls: 'btm-progress-fill' });

        this.progressText = contentEl.createDiv({ cls: 'btm-progress-text', text: `0 / ${this.total}` });
    }

    update(current: number) {
        const percent = Math.round((current / this.total) * 100);
        const fill = this.progressBar.querySelector('.btm-progress-fill') as HTMLElement;
        if (fill) fill.style.width = `${percent}%`;
        this.progressText.textContent = `${current} / ${this.total} (${percent}%)`;
    }

    onClose() {
        this.contentEl.empty();
    }
}

// Preview Modal
class PreviewModal extends Modal {
    private plugin: TagLowercasePlugin;
    private preview: PreviewResult;
    private onConfirm: (files: PreviewFile[]) => void;

    constructor(app: App, plugin: TagLowercasePlugin, preview: PreviewResult, onConfirm: (files: PreviewFile[]) => void) {
        super(app);
        this.plugin = plugin;
        this.preview = preview;
        this.onConfirm = onConfirm;
    }

    onOpen() {
        const { contentEl } = this;
        contentEl.empty();
        contentEl.addClass('btm-preview-modal');

        new Setting(contentEl).setName('Preview Changes').setHeading();
        contentEl.createEl('p', { text: `${this.preview.affectedFiles.length} files will be modified (${this.preview.totalChanges} changes)` });

        const listEl = contentEl.createDiv({ cls: 'btm-preview-list' });

        for (const file of this.preview.affectedFiles) {
            const fileEl = listEl.createDiv({ cls: 'btm-preview-file' });

            const headerEl = fileEl.createDiv({ cls: 'btm-preview-file-header' });
            const checkbox = headerEl.createEl('input', { type: 'checkbox' });
            checkbox.checked = file.included;
            checkbox.addEventListener('change', () => { file.included = checkbox.checked; });

            headerEl.createSpan({ text: file.path, cls: 'btm-preview-file-path' });
            headerEl.createSpan({ text: ` (${file.changes.length} changes)`, cls: 'btm-preview-file-count' });

            const changesEl = fileEl.createDiv({ cls: 'btm-preview-changes' });
            for (const change of file.changes.slice(0, 5)) {
                const changeEl = changesEl.createDiv({ cls: 'btm-preview-change' });
                changeEl.createDiv({ cls: 'btm-diff-remove', text: `L${change.line}: ${change.before}` });
                changeEl.createDiv({ cls: 'btm-diff-add', text: `L${change.line}: ${change.after}` });
            }
            if (file.changes.length > 5) {
                changesEl.createDiv({ text: `... and ${file.changes.length - 5} more`, cls: 'btm-more' });
            }
        }

        const btnContainer = contentEl.createDiv({ cls: 'btm-button-row' });

        const selectAllBtn = btnContainer.createEl('button', { text: 'Select All' });
        selectAllBtn.onclick = () => {
            this.preview.affectedFiles.forEach(f => f.included = true);
            listEl.querySelectorAll('input[type="checkbox"]').forEach((cb: HTMLInputElement) => cb.checked = true);
        };

        const selectNoneBtn = btnContainer.createEl('button', { text: 'Select None' });
        selectNoneBtn.onclick = () => {
            this.preview.affectedFiles.forEach(f => f.included = false);
            listEl.querySelectorAll('input[type="checkbox"]').forEach((cb: HTMLInputElement) => cb.checked = false);
        };

        const cancelBtn = btnContainer.createEl('button', { text: 'Cancel' });
        cancelBtn.onclick = () => this.close();

        const confirmBtn = btnContainer.createEl('button', { text: 'Apply Changes', cls: 'mod-cta' });
        confirmBtn.onclick = () => {
            this.close();
            this.onConfirm(this.preview.affectedFiles.filter(f => f.included));
        };
    }

    onClose() {
        this.contentEl.empty();
    }
}

// History Modal
class HistoryModal extends Modal {
    private plugin: TagLowercasePlugin;

    constructor(app: App, plugin: TagLowercasePlugin) {
        super(app);
        this.plugin = plugin;
    }

    onOpen() {
        const { contentEl } = this;
        contentEl.empty();
        contentEl.addClass('btm-history-modal');

        new Setting(contentEl).setName('Operation History').setHeading();

        if (this.plugin.settings.operationHistory.length === 0) {
            contentEl.createEl('p', { text: 'No operations recorded yet.' });
            return;
        }

        const listEl = contentEl.createDiv({ cls: 'btm-history-list' });

        for (const op of this.plugin.settings.operationHistory) {
            const itemEl = listEl.createDiv({ cls: 'btm-history-item' });

            const date = new Date(op.timestamp);
            const timeStr = date.toLocaleDateString() + ' ' + date.toLocaleTimeString();

            itemEl.createDiv({ cls: 'btm-history-time', text: timeStr });
            itemEl.createDiv({ cls: 'btm-history-desc', text: op.description });
            itemEl.createDiv({ cls: 'btm-history-files', text: `${op.changes.length} files affected` });

            if (op === this.plugin.settings.operationHistory[0]) {
                const revertBtn = itemEl.createEl('button', { text: 'Undo', cls: 'btm-revert-btn' });
                revertBtn.onclick = async () => {
                    this.close();
                    await this.plugin.undoLastOperation();
                };
            }
        }
    }

    onClose() {
        this.contentEl.empty();
    }
}

// Tag Hierarchy Modal
class TagHierarchyModal extends Modal {
    private plugin: TagLowercasePlugin;

    constructor(app: App, plugin: TagLowercasePlugin) {
        super(app);
        this.plugin = plugin;
    }

    onOpen() {
        const { contentEl } = this;
        contentEl.empty();
        contentEl.addClass('btm-hierarchy-modal');

        new Setting(contentEl).setName('Tag Hierarchy').setHeading();

        const hierarchy = this.plugin.getTagHierarchy();

        if (hierarchy.length === 0) {
            contentEl.createEl('p', { text: 'No tags found.' });
            return;
        }

        const treeEl = contentEl.createDiv({ cls: 'btm-tree' });
        this.renderTree(treeEl, hierarchy, 0);
    }

    private renderTree(container: HTMLElement, nodes: TagNode[], depth: number) {
        for (const node of nodes.sort((a, b) => a.name.localeCompare(b.name))) {
            const nodeEl = container.createDiv({ cls: 'btm-tree-node' });
            nodeEl.style.paddingLeft = `${depth * 20}px`;

            const hasChildren = node.children.length > 0;

            const headerEl = nodeEl.createDiv({ cls: 'btm-tree-header' });
            const iconEl = headerEl.createSpan({ cls: 'btm-tree-icon' });
            setIcon(iconEl, hasChildren ? 'folder' : 'tag');
            headerEl.createSpan({ text: node.name, cls: 'btm-tree-name' });
            if (node.count > 0) {
                headerEl.createSpan({ text: ` (${node.count})`, cls: 'btm-tree-count' });
            }

            if (hasChildren) {
                const childContainer = container.createDiv({ cls: 'btm-tree-children' });
                this.renderTree(childContainer, node.children, depth + 1);
            }
        }
    }

    onClose() {
        this.contentEl.empty();
    }
}

// Invalid Tags Modal
class InvalidTagsModal extends Modal {
    private plugin: TagLowercasePlugin;
    private invalidFiles: InvalidTagFile[];

    constructor(app: App, plugin: TagLowercasePlugin, invalidFiles: InvalidTagFile[]) {
        super(app);
        this.plugin = plugin;
        this.invalidFiles = invalidFiles;
    }

    onOpen() {
        const { contentEl } = this;
        contentEl.empty();
        contentEl.addClass('btm-invalid-modal');

        new Setting(contentEl)
            .setName('Files with Invalid Tag Format')
            .setDesc(`${this.invalidFiles.length} file${this.invalidFiles.length > 1 ? 's' : ''} found with tag format issues`)
            .setHeading();

        const listEl = contentEl.createDiv({ cls: 'btm-invalid-list' });

        for (const item of this.invalidFiles) {
            const itemEl = listEl.createDiv({ cls: 'btm-invalid-item' });

            const headerEl = itemEl.createDiv({ cls: 'btm-invalid-item-header' });
            const iconEl = headerEl.createSpan({ cls: 'btm-icon' });
            setIcon(iconEl, 'file-warning');

            const linkEl = headerEl.createEl('a', {
                text: item.path,
                cls: 'btm-invalid-file-link'
            });
            linkEl.onclick = (e) => {
                e.preventDefault();
                this.close();
                this.app.workspace.openLinkText(item.path, '', false);
            };

            const fixBtn = headerEl.createEl('button', { text: 'Fix', cls: 'btm-view-invalid-btn' });
            fixBtn.onclick = async () => {
                await this.plugin.fixAndStandardizeTags(item.file);
                new Notice(`Fixed tags in ${item.file.basename}`);
                itemEl.remove();
            };

            const issuesEl = itemEl.createDiv({ cls: 'btm-invalid-issues' });
            for (const issue of item.issues) {
                const issueEl = issuesEl.createDiv({ cls: 'btm-invalid-issue' });
                const issueIcon = issueEl.createSpan({ cls: 'btm-icon' });
                setIcon(issueIcon, 'alert-circle');
                issueEl.createSpan({ text: ' ' + issue });
            }
        }

        const btnRow = contentEl.createDiv({ cls: 'btm-button-row' });

        const fixAllBtn = btnRow.createEl('button', { text: 'Fix All', cls: 'mod-cta' });
        fixAllBtn.onclick = async () => {
            const progressModal = new ProgressModal(this.app, this.invalidFiles.length);
            progressModal.open();
            let count = 0;

            for (const item of this.invalidFiles) {
                try {
                    await this.plugin.fixAndStandardizeTags(item.file);
                    count++;
                    progressModal.update(count);
                } catch (e) {
                    console.error('Failed to fix ' + item.path, e);
                }
            }
            progressModal.close();
            new Notice(`Fixed tags in ${count} files.`);
            this.close();
        };

        const closeBtn = btnRow.createEl('button', { text: 'Close' });
        closeBtn.onclick = () => this.close();
    }

    onClose() {
        this.contentEl.empty();
    }
}

class EmptyTagsModal extends Modal {
    private emptyFiles: TFile[];

    constructor(app: App, emptyFiles: TFile[]) {
        super(app);
        this.emptyFiles = emptyFiles;
    }

    onOpen() {
        const { contentEl } = this;
        contentEl.empty();
        contentEl.addClass('btm-invalid-modal'); // Reuse styles

        new Setting(contentEl)
            .setName('Files with Empty Tags')
            .setDesc(`${this.emptyFiles.length} file${this.emptyFiles.length > 1 ? 's' : ''} found`)
            .setHeading();

        const listEl = contentEl.createDiv({ cls: 'btm-invalid-list' });

        for (const file of this.emptyFiles) {
            const itemEl = listEl.createDiv({ cls: 'btm-invalid-item' });
            const headerEl = itemEl.createDiv({ cls: 'btm-invalid-item-header' });
            // Simplified item
            const iconEl = headerEl.createSpan({ cls: 'btm-icon' });
            setIcon(iconEl, 'file');

            const linkEl = headerEl.createEl('a', {
                text: file.path,
                cls: 'btm-invalid-file-link'
            });
            linkEl.onclick = (e) => {
                e.preventDefault();
                this.close();
                this.app.workspace.openLinkText(file.path, '', false);
            };
        }

        const btnRow = contentEl.createDiv({ cls: 'btm-button-row' });
        const closeBtn = btnRow.createEl('button', { text: 'Close' });
        closeBtn.onclick = () => this.close();
    }

    onClose() {
        this.contentEl.empty();
    }
}

// Tag List Modal

// Inline Files Modal component
class InlineTagsModal extends Modal {
    private inlineFiles: { file: TFile; count: number; tags: string[] }[];

    constructor(app: App, inlineFiles: { file: TFile; count: number; tags: string[] }[]) {
        super(app);
        this.inlineFiles = inlineFiles;
    }

    onOpen() {
        const { contentEl } = this;
        contentEl.empty();
        contentEl.addClass('btm-invalid-modal');

        new Setting(contentEl)
            .setName('Notes with Inline Tags')
            .setDesc(`${this.inlineFiles.length} notes found with tags in body`)
            .setHeading();

        const listEl = contentEl.createDiv({ cls: 'btm-invalid-list' });

        for (const item of this.inlineFiles) {
            const itemEl = listEl.createDiv({ cls: 'btm-invalid-item' });

            const headerEl = itemEl.createDiv({ cls: 'btm-invalid-item-header' });
            const iconEl = headerEl.createSpan({ cls: 'btm-icon' });
            setIcon(iconEl, 'file-text');

            const titleEl = headerEl.createEl('a', {
                text: item.file.basename,
                cls: 'btm-invalid-file-link'
            });
            titleEl.onclick = () => {
                this.close();
                this.app.workspace.openLinkText(item.file.path, '', false);
            };

            const countSpan = headerEl.createSpan({ text: ` — ${item.count} inline tags`, cls: 'btm-highlight' });
            countSpan.style.marginLeft = '10px';
            countSpan.style.fontSize = '12px';

            const tagsEl = itemEl.createDiv({ cls: 'btm-metric-details' });
            tagsEl.style.marginTop = '8px';
            for (const tag of item.tags) {
                tagsEl.createSpan({ text: '#' + tag });
            }
        }

        const btnRow = contentEl.createDiv({ cls: 'btm-button-row' });
        const closeBtn = btnRow.createEl('button', { text: 'Close' });
        closeBtn.onclick = () => this.close();
    }

    onClose() {
        this.contentEl.empty();
    }
}

// Nested Files Modal component
class NestedFilesModal extends Modal {
    private nestedFiles: { file: TFile; count: number; tags: string[] }[];

    constructor(app: App, nestedFiles: { file: TFile; count: number; tags: string[] }[]) {
        super(app);
        this.nestedFiles = nestedFiles;
    }

    onOpen() {
        const { contentEl } = this;
        contentEl.empty();
        contentEl.addClass('btm-invalid-modal');

        new Setting(contentEl)
            .setName('Notes with Nested Tags')
            .setDesc(`${this.nestedFiles.length} notes found containing hierarchical tags`)
            .setHeading();

        const listEl = contentEl.createDiv({ cls: 'btm-invalid-list' });

        for (const item of this.nestedFiles) {
            const itemEl = listEl.createDiv({ cls: 'btm-invalid-item' });

            const headerEl = itemEl.createDiv({ cls: 'btm-invalid-item-header' });
            const iconEl = headerEl.createSpan({ cls: 'btm-icon' });
            setIcon(iconEl, 'file-text');

            const titleEl = headerEl.createEl('a', {
                text: item.file.basename,
                cls: 'btm-invalid-file-link'
            });
            titleEl.onclick = () => {
                this.close();
                this.app.workspace.openLinkText(item.file.path, '', false);
            };

            const countSpan = headerEl.createSpan({ text: ` — ${item.count} nested tags`, cls: 'btm-highlight' });
            countSpan.style.marginLeft = '10px';
            countSpan.style.fontSize = '12px';

            const tagsEl = itemEl.createDiv({ cls: 'btm-metric-details' });
            tagsEl.style.marginTop = '8px';
            for (const tag of item.tags) {
                tagsEl.createSpan({ text: '#' + tag });
            }
        }

        const btnRow = contentEl.createDiv({ cls: 'btm-button-row' });
        const closeBtn = btnRow.createEl('button', { text: 'Close' });
        closeBtn.onclick = () => this.close();
    }

    onClose() {
        this.contentEl.empty();
    }
}

// Tag List Modal

class TagListModal extends Modal {
    private tags: string[];
    private title: string;

    constructor(app: App, title: string, tags: string[]) {
        super(app);
        this.title = title;
        this.tags = tags;
    }

    onOpen() {
        const { contentEl } = this;
        contentEl.empty();
        contentEl.addClass('btm-tag-list-modal');

        new Setting(contentEl)
            .setName(this.title)
            .setDesc(`${this.tags.length} tags found`)
            .setHeading();

        const listEl = contentEl.createDiv({ cls: 'btm-invalid-list' });

        for (const tag of this.tags) {
            const itemEl = listEl.createDiv({ cls: 'btm-invalid-item btm-tag-item' });

            // Tag with color? (Remove duplicated hash)
            const tagText = tag.startsWith('#') ? tag : '#' + tag;
            const tagEl = itemEl.createSpan({ text: tagText, cls: 'btm-tag-pill' });
            // Should be clickable to search

            const btn = itemEl.createEl('button', { text: 'Search', cls: 'btm-search-btn' });
            btn.onclick = () => {
                this.close();
                // Open global search
                const searchPlugin = (this.app as any).internalPlugins?.getPluginById('global-search');
                if (searchPlugin?.instance) {
                    searchPlugin.instance.openGlobalSearch(`tag:${tagText}`);
                } else {
                    new Notice('Global Search plugin not enabled');
                }
            };
        }

        const btnRow = contentEl.createDiv({ cls: 'btm-button-row' });
        const closeBtn = btnRow.createEl('button', { text: 'Close' });
        closeBtn.onclick = () => this.close();
    }

    onClose() {
        this.contentEl.empty();
    }
}

// Orphan Tags Modal

class OrphanTagsModal extends Modal {
    private plugin: TagLowercasePlugin;

    constructor(app: App, plugin: TagLowercasePlugin) {
        super(app);
        this.plugin = plugin;
    }

    onOpen() {
        const { contentEl } = this;
        contentEl.empty();
        contentEl.addClass('btm-orphan-modal');

        new Setting(contentEl)
            .setName('Orphaned Tags')
            .setDesc(`Tags used in fewer than ${this.plugin.settings.orphanThreshold} files`)
            .setHeading();

        const orphans = this.plugin.findOrphanedTags();

        if (orphans.length === 0) {
            contentEl.createEl('p', { text: 'No orphaned tags found!' });
            return;
        }

        contentEl.createEl('p', { text: `Found ${orphans.length} orphaned tags:` });

        const listEl = contentEl.createDiv({ cls: 'btm-orphan-list' });

        for (const { tag, count } of orphans) {
            const itemEl = listEl.createDiv({ cls: 'btm-orphan-item' });
            itemEl.createSpan({ text: tag, cls: 'btm-orphan-tag' });
            itemEl.createSpan({ text: ` (${count} use${count === 1 ? '' : 's'})`, cls: 'btm-orphan-count' });
        }
    }

    onClose() {
        this.contentEl.empty();
    }
}

// Tag Suggest for Autocomplete (with counts)
class TagSuggest extends SuggestModal<string> {
    private plugin: TagLowercasePlugin;
    private onSelect: (tag: string) => void;
    private tagCounts: Record<string, number>;

    constructor(app: App, plugin: TagLowercasePlugin, onSelect: (tag: string) => void) {
        super(app);
        this.plugin = plugin;
        this.onSelect = onSelect;
        this.tagCounts = this.plugin.app.metadataCache.getTags() || {};
    }

    getSuggestions(query: string): string[] {
        const tags = this.plugin.getAllTags();
        if (!query) return tags.slice(0, 50);
        return tags.filter(t => t.toLowerCase().includes(query.toLowerCase())).slice(0, 50);
    }

    renderSuggestion(tag: string, el: HTMLElement) {
        const count = this.tagCounts['#' + tag] || 0;
        el.createSpan({ text: `#${tag}`, cls: 'btm-suggest-tag' });
        el.createSpan({ text: ` (${count})`, cls: 'btm-suggest-count' });
    }

    onChooseSuggestion(tag: string) {
        this.onSelect(tag);
    }
}

// Multi-Select Tag Modal for Merge
class MultiTagSelectModal extends Modal {
    private plugin: TagLowercasePlugin;
    private selectedTags: Set<string> = new Set();
    private onConfirm: (tags: string[]) => void;
    private listEl: HTMLElement;
    private searchInput: TextComponent;
    private tagCounts: Record<string, number>;

    constructor(app: App, plugin: TagLowercasePlugin, onConfirm: (tags: string[]) => void) {
        super(app);
        this.plugin = plugin;
        this.onConfirm = onConfirm;
        this.tagCounts = this.plugin.app.metadataCache.getTags() || {};
    }

    onOpen() {
        const { contentEl } = this;
        contentEl.empty();
        contentEl.addClass('btm-multiselect-modal');

        new Setting(contentEl).setName('Select Tags to Merge').setHeading();

        const searchDiv = contentEl.createDiv({ cls: 'btm-search-container' });
        this.searchInput = new TextComponent(searchDiv).setPlaceholder('Search tags...');
        this.searchInput.inputEl.addEventListener('input', () => this.renderList());

        const selectedDiv = contentEl.createDiv({ cls: 'btm-selected-tags' });
        selectedDiv.id = 'btm-selected-display';

        this.listEl = contentEl.createDiv({ cls: 'btm-tag-list' });
        this.renderList();

        const btnRow = contentEl.createDiv({ cls: 'btm-button-row' });
        const cancelBtn = btnRow.createEl('button', { text: 'Cancel' });
        cancelBtn.onclick = () => this.close();

        const confirmBtn = btnRow.createEl('button', { text: 'Confirm Selection', cls: 'mod-cta' });
        confirmBtn.onclick = () => {
            this.close();
            this.onConfirm(Array.from(this.selectedTags));
        };
    }

    private renderList() {
        this.listEl.empty();
        const query = this.searchInput.getValue().toLowerCase();
        const tags = this.plugin.getAllTags();
        const filtered = query ? tags.filter(t => t.toLowerCase().includes(query)) : tags;

        for (const tag of filtered.slice(0, 100)) {
            const count = this.tagCounts['#' + tag] || 0;
            const itemEl = this.listEl.createDiv({ cls: 'btm-tag-item' });

            const checkbox = itemEl.createEl('input', { type: 'checkbox' });
            checkbox.checked = this.selectedTags.has(tag);
            checkbox.addEventListener('change', () => {
                if (checkbox.checked) {
                    this.selectedTags.add(tag);
                } else {
                    this.selectedTags.delete(tag);
                }
                this.updateSelectedDisplay();
            });

            itemEl.createSpan({ text: `#${tag}`, cls: 'btm-tag-name' });
            itemEl.createSpan({ text: ` (${count})`, cls: 'btm-tag-count' });
        }

        this.updateSelectedDisplay();
    }

    private updateSelectedDisplay() {
        const display = this.contentEl.querySelector('#btm-selected-display');
        if (display) {
            display.empty();
            if (this.selectedTags.size > 0) {
                display.createSpan({ text: `Selected (${this.selectedTags.size}): ` });
                display.createSpan({ text: Array.from(this.selectedTags).map(t => '#' + t).join(', '), cls: 'btm-selected-list' });
            }
        }
    }

    onClose() {
        this.contentEl.empty();
    }
}

// Folder Select Modal for Scope Filtering
class FolderSelectModal extends Modal {
    private plugin: TagLowercasePlugin;
    private selectedFolders: Set<string>;
    private onConfirm: (folders: string[]) => void;
    private listEl: HTMLElement;
    private searchInput: TextComponent;

    constructor(app: App, plugin: TagLowercasePlugin, currentFolders: string[], onConfirm: (folders: string[]) => void) {
        super(app);
        this.plugin = plugin;
        this.selectedFolders = new Set(currentFolders.filter(f => f));
        this.onConfirm = onConfirm;
    }

    onOpen() {
        const { contentEl } = this;
        contentEl.empty();
        contentEl.addClass('btm-folder-modal');

        new Setting(contentEl).setName('Select Folders').setHeading();

        const searchDiv = contentEl.createDiv({ cls: 'btm-search-container' });
        this.searchInput = new TextComponent(searchDiv).setPlaceholder('Search folders...');
        this.searchInput.inputEl.addEventListener('input', () => this.renderList());

        const selectedDiv = contentEl.createDiv({ cls: 'btm-selected-tags' });
        selectedDiv.id = 'btm-selected-folders-display';

        this.listEl = contentEl.createDiv({ cls: 'btm-tag-list' });
        this.renderList();

        const btnRow = contentEl.createDiv({ cls: 'btm-button-row' });
        const cancelBtn = btnRow.createEl('button', { text: 'Cancel' });
        cancelBtn.onclick = () => this.close();

        const confirmBtn = btnRow.createEl('button', { text: 'Confirm Selection', cls: 'mod-cta' });
        confirmBtn.onclick = () => {
            this.close();
            this.onConfirm(Array.from(this.selectedFolders));
        };
    }

    private getAllFolders(): string[] {
        const folders: string[] = [];
        const collectFolders = (folder: TFolder) => {
            if (folder.path && folder.path !== '/') {
                folders.push(folder.path);
            }
            for (const child of folder.children) {
                if (child instanceof TFolder) {
                    collectFolders(child);
                }
            }
        };
        collectFolders(this.app.vault.getRoot());
        return folders.sort();
    }

    private renderList() {
        this.listEl.empty();
        const query = this.searchInput.getValue().toLowerCase();
        const folders = this.getAllFolders();
        const filtered = query ? folders.filter(f => f.toLowerCase().includes(query)) : folders;

        if (filtered.length === 0) {
            this.listEl.createEl('p', { text: 'No folders found', cls: 'btm-no-results' });
            return;
        }

        for (const folder of filtered.slice(0, 100)) {
            const itemEl = this.listEl.createDiv({ cls: 'btm-tag-item' });

            const checkbox = itemEl.createEl('input', { type: 'checkbox' });
            checkbox.checked = this.selectedFolders.has(folder);
            checkbox.addEventListener('change', () => {
                if (checkbox.checked) {
                    this.selectedFolders.add(folder);
                } else {
                    this.selectedFolders.delete(folder);
                }
                this.updateSelectedDisplay();
            });

            const folderIcon = itemEl.createSpan({ cls: 'btm-icon' });
            setIcon(folderIcon, 'folder');
            itemEl.createSpan({ text: ' ' + folder, cls: 'btm-folder-name' });
        }

        this.updateSelectedDisplay();
    }

    private updateSelectedDisplay() {
        const display = this.contentEl.querySelector('#btm-selected-folders-display');
        if (display) {
            display.empty();
            if (this.selectedFolders.size > 0) {
                display.createSpan({ text: `Selected (${this.selectedFolders.size}): ` });
                display.createSpan({ text: Array.from(this.selectedFolders).join(', '), cls: 'btm-selected-list' });
            }
        }
    }

    onClose() {
        this.contentEl.empty();
    }
}

// --- Main Dashboard Modal ---

class TagManagerModal extends Modal {
    plugin: TagLowercasePlugin;
    statsEl: HTMLElement;
    findInput: TextComponent;
    replaceInput: TextComponent;
    mergeSourcesInput: TextComponent;
    mergeTargetInput: TextComponent;
    patternInput: TextComponent;
    patternReplaceInput: TextComponent;
    metricsGrid: HTMLElement; // For layout consistency

    constructor(app: App, plugin: TagLowercasePlugin) {
        super(app);
        this.plugin = plugin;
    }

    onOpen() {
        const { contentEl } = this;
        contentEl.empty();
        contentEl.addClass('btm-dashboard');

        new Setting(contentEl).setName('Bulk Tag Manager').setHeading();

        // --- Overview Section (Collapsible) ---
        const overviewBox = contentEl.createDiv({ cls: 'btm-section-box' });
        const overviewHeader = overviewBox.createDiv({ cls: 'btm-collapsible-header' });
        overviewHeader.createSpan({ text: 'Overview (Stats)' });
        const arrow = overviewHeader.createSpan({ cls: 'btm-header-arrow' });
        setIcon(arrow, 'chevron-down');

        this.statsEl = overviewBox.createDiv({ cls: 'btm-collapsible-content' });
        this.updateStats();

        // Toggle logic
        let isExpanded = true;
        overviewHeader.onclick = () => {
            isExpanded = !isExpanded;
            if (isExpanded) {
                this.statsEl.removeClass('is-collapsed');
                arrow.removeClass('is-collapsed');
            } else {
                this.statsEl.addClass('is-collapsed');
                arrow.addClass('is-collapsed');
            }
        };

        // --- Rename Section ---
        const renameBox = contentEl.createDiv({ cls: 'btm-section-box' });
        renameBox.createDiv({ cls: 'btm-collapsible-header' }).createSpan({ text: 'Rename Tag' });

        const renameContainer = renameBox.createDiv({ cls: 'btm-aligned-row' });

        // Col 1: Find
        const findCol = renameContainer.createDiv({ cls: 'btm-field-column' });
        findCol.createEl('label', { text: 'Find' });
        this.findInput = new TextComponent(findCol).setPlaceholder('#old-tag');
        const findSuggestBtn = findCol.createEl('button', { cls: 'btm-suggest-btn btm-icon-btn btm-small-center-btn' });
        setIcon(findSuggestBtn, 'search');
        findSuggestBtn.createSpan({ text: ' Search' });
        const tagCountDisplay = findCol.createDiv({ cls: 'btm-tag-count-display', attr: { style: 'font-size: 11px; margin-top: 4px; color: var(--text-muted);' } });

        findSuggestBtn.onclick = () => new TagSuggest(this.app, this.plugin, (t) => {
            this.findInput.setValue(t);
            const tags = this.plugin.app.metadataCache.getTags() || {};
            const count = tags['#' + t] || 0;
            tagCountDisplay.textContent = `${count} pos`;
        }).open();

        // Col 2: Replace
        const replaceCol = renameContainer.createDiv({ cls: 'btm-field-column' });
        replaceCol.createEl('label', { text: 'Replace' });
        this.replaceInput = new TextComponent(replaceCol).setPlaceholder('#new-tag');

        // Col 3: Action
        const btnRename = renameContainer.createEl('button', { text: 'Rename', cls: 'mod-cta btm-action-btn' });
        btnRename.onclick = async () => {
            const oldT = this.findInput.getValue();
            const newT = this.replaceInput.getValue();
            if (oldT && newT) {
                this.close();
                await this.plugin.renameTag(oldT, newT);
            } else {
                new Notice('Please fill both fields.');
            }
        };

        // --- Merge Section ---
        const mergeBox = contentEl.createDiv({ cls: 'btm-section-box' });
        mergeBox.createDiv({ cls: 'btm-collapsible-header' }).createSpan({ text: 'Merge Tags' });

        const mergeContainer = mergeBox.createDiv({ cls: 'btm-aligned-row' });

        // Col 1: Source
        const sourceCol = mergeContainer.createDiv({ cls: 'btm-field-column' });
        sourceCol.createEl('label', { text: 'Source tags' });
        this.mergeSourcesInput = new TextComponent(sourceCol).setPlaceholder('#tag1, #tag2');
        const selectTagsBtn = sourceCol.createEl('button', { cls: 'btm-suggest-btn btm-icon-btn btm-small-center-btn' });
        setIcon(selectTagsBtn, 'list-filter');
        selectTagsBtn.createSpan({ text: ' Select' });
        selectTagsBtn.onclick = () => new MultiTagSelectModal(this.app, this.plugin, (tags) => {
            this.mergeSourcesInput.setValue(tags.map(t => '#' + t).join(', '));
        }).open();

        // Col 2: Target
        const targetCol = mergeContainer.createDiv({ cls: 'btm-field-column' });
        targetCol.createEl('label', { text: 'Target' });
        this.mergeTargetInput = new TextComponent(targetCol).setPlaceholder('#merged');
        const targetSuggestBtn = targetCol.createEl('button', { cls: 'btm-suggest-btn btm-icon-btn btm-small-center-btn' });
        setIcon(targetSuggestBtn, 'search');
        targetSuggestBtn.createSpan({ text: ' Search' });
        targetSuggestBtn.onclick = () => new TagSuggest(this.app, this.plugin, (t) => this.mergeTargetInput.setValue(t)).open();

        // Col 3: Action
        const btnMerge = mergeContainer.createEl('button', { text: 'Merge', cls: 'mod-cta btm-action-btn' });
        btnMerge.onclick = async () => {
            const sources = this.mergeSourcesInput.getValue().split(',').map(s => s.trim()).filter(s => s);
            const target = this.mergeTargetInput.getValue().trim();
            if (sources.length > 0 && target) {
                this.close();
                await this.plugin.mergeTags(sources, target);
            } else {
                new Notice('Please provide source tags and a target.');
            }
        };

        // --- Pattern Rename Section ---
        const patternBox = contentEl.createDiv({ cls: 'btm-section-box' });
        patternBox.createDiv({ cls: 'btm-collapsible-header' }).createSpan({ text: 'Pattern Rename (Regex)' });

        const patternContainer = patternBox.createDiv({ cls: 'btm-aligned-row' });

        // Col 1: Pattern
        const patternCol = patternContainer.createDiv({ cls: 'btm-field-column' });
        patternCol.createEl('label', { text: 'Pattern' });
        this.patternInput = new TextComponent(patternCol).setPlaceholder('^old-(.*)');

        // Col 2: Replacement
        const patternRepCol = patternContainer.createDiv({ cls: 'btm-field-column' });
        patternRepCol.createEl('label', { text: 'Replacement' });
        this.patternReplaceInput = new TextComponent(patternRepCol).setPlaceholder('new-$1');

        // Col 3: Action
        const btnPattern = patternContainer.createEl('button', { text: 'Apply', cls: 'mod-cta btm-action-btn' });
        btnPattern.onclick = async () => {
            const pattern = this.patternInput.getValue();
            const replacement = this.patternReplaceInput.getValue();
            if (pattern) {
                this.close();
                await this.plugin.batchRename(pattern, replacement);
            } else {
                new Notice('Please provide a pattern.');
            }
        };

        // --- Bulk Settings ---
        const settingsBox = contentEl.createDiv({ cls: 'btm-section-box' });
        settingsBox.createDiv({ cls: 'btm-collapsible-header' }).createSpan({ text: 'Bulk Settings' });

        new Setting(settingsBox)
            .setName('Case Strategy')
            .addDropdown(dropdown => dropdown
                .addOption('lowercase', 'Lowercase')
                .addOption('uppercase', 'Uppercase')
                .addOption('none', 'No Change')
                .setValue(this.plugin.settings.caseStrategy)
                .onChange(async (value: TagLowercaseSettings['caseStrategy']) => {
                    this.plugin.settings.caseStrategy = value;
                    await this.plugin.saveSettings();
                    this.updateStats();
                }));

        new Setting(settingsBox)
            .setName('Separator Style')
            .addDropdown(dropdown => dropdown
                .addOption('preserve', 'Preserve')
                .addOption('snake', 'Snake Case')
                .addOption('kebab', 'Kebab Case')
                .setValue(this.plugin.settings.separatorStrategy)
                .onChange(async (value: TagLowercaseSettings['separatorStrategy']) => {
                    this.plugin.settings.separatorStrategy = value;
                    await this.plugin.saveSettings();
                    this.updateStats();
                }));

        new Setting(settingsBox)
            .setName('Remove Special Characters')
            .addToggle(toggle => toggle
                .setValue(this.plugin.settings.removeSpecialChars)
                .onChange(async (value) => {
                    this.plugin.settings.removeSpecialChars = value;
                    await this.plugin.saveSettings();
                    this.updateStats();
                }));

        new Setting(settingsBox)
            .setName('Apply to Nested Tags')
            .addToggle(toggle => toggle
                .setValue(this.plugin.settings.applyToNestedTags)
                .onChange(async (value) => {
                    this.plugin.settings.applyToNestedTags = value;
                    await this.plugin.saveSettings();
                    this.updateStats();
                }));

        // --- Scope Filter ---
        const scopeBox = contentEl.createDiv({ cls: 'btm-section-box' });
        scopeBox.createDiv({ cls: 'btm-collapsible-header' }).createSpan({ text: 'Scope Filter' });

        new Setting(scopeBox)
            .setName('Enable Scope Filter')
            .setDesc('Limit operations to specific folders')
            .addToggle(toggle => toggle
                .setValue(this.plugin.settings.scopeFilter.enabled)
                .onChange(async (value) => {
                    this.plugin.settings.scopeFilter.enabled = value;
                    await this.plugin.saveSettings();
                    this.updateStats();
                }));

        const includeRow = scopeBox.createDiv({ cls: 'btm-scope-row', attr: { style: 'margin-bottom: 8px;' } });
        includeRow.createSpan({ text: 'Include: ' });
        const includeDisplay = includeRow.createSpan({ text: this.plugin.settings.scopeFilter.includeFolders.join(', ') || '(all)', cls: 'btm-folder-display', attr: { style: 'margin-right: 8px;' } });
        const includeBtn = includeRow.createEl('button', { cls: 'btm-suggest-btn btm-icon-btn btm-small-center-btn' });
        setIcon(includeBtn, 'folder-plus');
        includeBtn.createSpan({ text: ' Select' });
        includeBtn.onclick = () => new FolderSelectModal(this.app, this.plugin, this.plugin.settings.scopeFilter.includeFolders, async (f) => {
            this.plugin.settings.scopeFilter.includeFolders = f;
            await this.plugin.saveSettings();
            includeDisplay.textContent = f.join(', ') || '(all)';
            this.updateStats();
        }).open();

        const excludeRow = scopeBox.createDiv({ cls: 'btm-scope-row' });
        excludeRow.createSpan({ text: 'Exclude: ' });
        const excludeDisplay = excludeRow.createSpan({ text: this.plugin.settings.scopeFilter.excludeFolders.join(', ') || '(none)', cls: 'btm-folder-display', attr: { style: 'margin-right: 8px;' } });
        const excludeBtn = excludeRow.createEl('button', { cls: 'btm-suggest-btn btm-icon-btn btm-small-center-btn' });
        setIcon(excludeBtn, 'folder-minus');
        excludeBtn.createSpan({ text: ' Select' });
        excludeBtn.onclick = () => new FolderSelectModal(this.app, this.plugin, this.plugin.settings.scopeFilter.excludeFolders, async (f) => {
            this.plugin.settings.scopeFilter.excludeFolders = f;
            await this.plugin.saveSettings();
            excludeDisplay.textContent = f.join(', ') || '(none)';
            this.updateStats();
        }).open();

        // --- Action Row (Bottom) ---
        const actionBox = contentEl.createDiv({ cls: 'btm-section-box' });
        actionBox.createDiv({ cls: 'btm-collapsible-header' }).createSpan({ text: 'Actions' });
        const actionRow = actionBox.createDiv({ cls: 'btm-action-row' });

        const btnConvert = this.createIconButton(actionRow, 'refresh-cw', 'Convert All', 'mod-cta');
        setTooltip(btnConvert, 'Run full conversion/standardization based on settings');
        btnConvert.onclick = async () => { this.close(); await this.plugin.runConversionWithPreview(); };

        const btnList = this.createIconButton(actionRow, 'list', 'Tag List');
        setTooltip(btnList, 'View all tags in a list');
        btnList.onclick = async () => { this.close(); await this.plugin.generateTagList(); };

        const btnHierarchy = this.createIconButton(actionRow, 'git-branch', 'Hierarchy');
        setTooltip(btnHierarchy, 'View tag hierarchy tree');
        btnHierarchy.onclick = () => { this.close(); new TagHierarchyModal(this.app, this.plugin).open(); };

        const btnOrphans = this.createIconButton(actionRow, 'alert-circle', 'Orphans');
        setTooltip(btnOrphans, 'Find orphaned tags');
        btnOrphans.onclick = () => { this.close(); new OrphanTagsModal(this.app, this.plugin).open(); };

        const btnHistory = this.createIconButton(actionRow, 'history', 'History');
        setTooltip(btnHistory, 'View and revert recent changes');
        btnHistory.onclick = () => { this.close(); new HistoryModal(this.app, this.plugin).open(); };

        const btnStandardize = this.createIconButton(actionRow, 'check-square', 'Fix Invalid');
        setTooltip(btnStandardize, 'Standardize formats (commas/spaces)');
        btnStandardize.onclick = async () => { this.close(); await this.plugin.standardizeAllTags(); };
    }

    createIconButton(container: HTMLElement, iconName: string, text: string, cls: string = ''): HTMLButtonElement {
        const btn = container.createEl('button', { cls: `btm-icon-btn ${cls}`.trim() });
        const iconEl = btn.createSpan({ cls: 'btm-btn-icon' });
        setIcon(iconEl, iconName);
        btn.createSpan({ text: ' ' + text });
        return btn;
    }

    createProgressBar(container: HTMLElement, value: number) {
        const bar = container.createDiv({ cls: 'btm-progress-bar-mini' });
        const fill = bar.createDiv({ cls: 'btm-progress-fill-mini' });
        fill.style.width = `${value}%`;
        if (value < 50) fill.addClass('btm-progress-low');
        else if (value < 80) fill.addClass('btm-progress-medium');
        else fill.addClass('btm-progress-high');
    }

    updateStats() {
        this.statsEl.empty();
        this.statsEl.addClass('btm-standardization-panel');

        const files = this.plugin.getFilteredFiles();
        // Pass files to analyzer
        const stats = this.plugin.analyzeTagStandardization(files);

        // Header stats
        const headerRow = this.statsEl.createDiv({ cls: 'btm-stats-header' });
        const tagsItem = headerRow.createSpan({ cls: 'btm-stat-item' });
        setIcon(tagsItem.createSpan({ cls: 'btm-stat-icon' }), 'tags');
        tagsItem.createSpan({ text: ` ${stats.totalTags} tags` });

        const filesItem = headerRow.createSpan({ cls: 'btm-stat-item' });
        setIcon(filesItem.createSpan({ cls: 'btm-stat-icon' }), 'files');
        filesItem.createSpan({ text: ` ${files.length} files` });

        // Standardization metrics - Create Grid
        this.metricsGrid = this.statsEl.createDiv({ cls: 'btm-metrics-grid' });

        const createStatLink = (container: HTMLElement, count: number, label: string, tags: string[]) => {
            if (count > 0) {
                const link = container.createEl('a', { text: `${count} ${label}`, cls: 'btm-stat-link' });
                link.onclick = () => {
                    this.close();
                    new TagListModal(this.app, `${label} Tags`, tags).open();
                };
                container.appendText(' ');
            }
        };

        // Case consistency
        const caseBox = this.metricsGrid.createDiv({ cls: 'btm-metric-box' });
        caseBox.createDiv({ text: 'Case', cls: 'btm-metric-label' });
        this.createProgressBar(caseBox, stats.caseStats.consistency);
        const caseDetails = caseBox.createDiv({ cls: 'btm-metric-details' });
        createStatLink(caseDetails, stats.caseStats.lowercase.length, 'lower', stats.caseStats.lowercase);
        createStatLink(caseDetails, stats.caseStats.uppercase.length, 'UPPER', stats.caseStats.uppercase);
        createStatLink(caseDetails, stats.caseStats.mixed.length, 'Mixed', stats.caseStats.mixed);

        // Separator consistency
        const sepBox = this.metricsGrid.createDiv({ cls: 'btm-metric-box' });
        sepBox.createDiv({ text: 'Separators', cls: 'btm-metric-label' });
        this.createProgressBar(sepBox, stats.separatorStats.consistency);
        const sepDetails = sepBox.createDiv({ cls: 'btm-metric-details' });
        createStatLink(sepDetails, stats.separatorStats.hyphen.length, 'kebab-case', stats.separatorStats.hyphen);
        createStatLink(sepDetails, stats.separatorStats.underscore.length, 'snake_case', stats.separatorStats.underscore);
        createStatLink(sepDetails, stats.separatorStats.both.length, 'mixed', stats.separatorStats.both);
        createStatLink(sepDetails, stats.separatorStats.none.length, 'none', stats.separatorStats.none);

        // Special characters
        const specialBox = this.metricsGrid.createDiv({ cls: 'btm-metric-box' });
        specialBox.createDiv({ text: 'Clean Tags', cls: 'btm-metric-label' });
        this.createProgressBar(specialBox, stats.specialCharStats.consistency);
        const specialDetails = specialBox.createDiv({ cls: 'btm-metric-details' });
        createStatLink(specialDetails, stats.specialCharStats.clean.length, 'clean', stats.specialCharStats.clean);
        createStatLink(specialDetails, stats.specialCharStats.withSpecial.length, 'with special chars', stats.specialCharStats.withSpecial);

        // Hierarchical stats
        const nestBox = this.metricsGrid.createDiv({ cls: 'btm-metric-box' });
        nestBox.createDiv({ text: 'Hierarchy', cls: 'btm-metric-label' });
        const nestDetails = nestBox.createDiv({ cls: 'btm-metric-details' });
        createStatLink(nestDetails, stats.nestingStats.flat.length, 'flat', stats.nestingStats.flat);

        if (stats.inlineFiles.length > 0) {
            const nestedLink = nestDetails.createEl('a', { text: `${stats.inlineFiles.length} notes with inline tags`, cls: 'btm-stat-link' });
            nestedLink.onclick = () => {
                this.close();
                new InlineTagsModal(this.app, stats.inlineFiles).open();
            };
        } else {
            nestDetails.createSpan({ text: '0 notes with inline tags' });
        }

        if (stats.nestedFiles.length > 0) {
            const realNestedLink = nestDetails.createEl('a', { text: `${stats.nestedFiles.length} with nested tags`, cls: 'btm-stat-link' });
            realNestedLink.onclick = () => {
                this.close();
                new NestedFilesModal(this.app, stats.nestedFiles).open();
            };
        } else {
            nestDetails.createSpan({ text: '0 with nested tags' });
        }

        // Location Stats (Body vs Frontmatter)
        const locBox = this.metricsGrid.createDiv({ cls: 'btm-metric-box' });
        locBox.createDiv({ text: 'Locations', cls: 'btm-metric-label' });
        const locDetails = locBox.createDiv({ cls: 'btm-metric-details' });
        createStatLink(locDetails, stats.locationStats.frontmatter.length, 'frontmatter', stats.locationStats.frontmatter);
        createStatLink(locDetails, stats.locationStats.body.length, 'body', stats.locationStats.body);

        // Length stats
        const lengthBox = this.metricsGrid.createDiv({ cls: 'btm-metric-box' });
        lengthBox.createDiv({ text: 'Length', cls: 'btm-metric-label' });
        const lengthDetails = lengthBox.createDiv({ cls: 'btm-metric-details' });
        lengthDetails.createSpan({ text: `avg: ${stats.lengthStats.avgLength} chars ` });
        createStatLink(lengthDetails, stats.lengthStats.long.length, 'long (>25)', stats.lengthStats.long);

        // Async check for invalid tags
        this.checkInvalidTags();
        this.checkEmptyTags();
    }


    async checkEmptyTags() {
        const emptyFiles = await this.plugin.findEmptyTags();
        if (emptyFiles.length > 0) {
            // Append to metricsGrid to ensure uniform spacing
            // Note: metricsGrid ensures grid layout
            if (this.metricsGrid) {
                const emptyBox = this.metricsGrid.createDiv({ cls: 'btm-metric-box btm-info-box' });
                emptyBox.createDiv({ text: 'Empty Tags', cls: 'btm-metric-label' });
                const detail = emptyBox.createDiv({ cls: 'btm-metric-details' });
                const link = detail.createEl('a', { text: `${emptyFiles.length} files` });
                link.onclick = () => {
                    this.close();
                    new EmptyTagsModal(this.app, emptyFiles).open();
                };
            }
        }
    }
    async checkInvalidTags() {
        const invalidFiles = await this.plugin.findInvalidTagFormats();

        if (invalidFiles.length > 0) {
            // Find or create the invalid tags section
            let invalidSection = this.statsEl.querySelector('.btm-invalid-section');
            if (!invalidSection) {
                invalidSection = this.statsEl.createDiv({ cls: 'btm-invalid-section' });
            }
            invalidSection.empty();

            const warningRow = (invalidSection as HTMLElement).createDiv({ cls: 'btm-invalid-warning' });
            const iconEl = warningRow.createSpan({ cls: 'btm-icon' });
            setIcon(iconEl, 'alert-triangle');
            warningRow.createSpan({ text: ` ${invalidFiles.length} file${invalidFiles.length > 1 ? 's' : ''} with invalid tag format` });

            const viewBtn = warningRow.createEl('button', { text: 'View', cls: 'btm-view-invalid-btn' });
            viewBtn.onclick = () => {
                this.close();
                new InvalidTagsModal(this.app, this.plugin, invalidFiles).open();
            };
        }
    }




    onClose() {
        this.contentEl.empty();
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

        new Setting(containerEl).setName('Bulk Tag Manager Settings').setHeading();
        containerEl.createEl('p', { text: 'Access the full dashboard via the ribbon icon or command palette.' });

        new Setting(containerEl)
            .setName('Case Strategy')
            .addDropdown(dropdown => dropdown
                .addOption('lowercase', 'Lowercase')
                .addOption('uppercase', 'Uppercase')
                .addOption('none', 'No Change')
                .setValue(this.plugin.settings.caseStrategy)
                .onChange(async (value: TagLowercaseSettings['caseStrategy']) => {
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
                .onChange(async (value: TagLowercaseSettings['separatorStrategy']) => {
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

        new Setting(containerEl)
            .setName('Tag Output Format')
            .setDesc('Format for writing tags to frontmatter')
            .addDropdown(dropdown => dropdown
                .addOption('inline', 'Inline Array [tag1, tag2]')
                .addOption('list', 'YAML List (- tag1)')
                .setValue(this.plugin.settings.tagFormat)
                .onChange(async (value: TagLowercaseSettings['tagFormat']) => {
                    this.plugin.settings.tagFormat = value;
                    await this.plugin.saveSettings();
                }));

        new Setting(containerEl).setName('Aliases').setHeading();
        containerEl.createEl('p', { text: 'Define tag aliases that automatically correct to canonical tags.' });

        const aliasesContainer = containerEl.createDiv({ cls: 'btm-aliases' });
        this.renderAliases(aliasesContainer);

        new Setting(containerEl).setName('History').setHeading();

        new Setting(containerEl)
            .setName('Max History Size')
            .setDesc('Number of operations to keep in history')
            .addSlider(slider => slider
                .setLimits(10, 100, 10)
                .setValue(this.plugin.settings.maxHistorySize)
                .setDynamicTooltip()
                .onChange(async (value) => {
                    this.plugin.settings.maxHistorySize = value;
                    await this.plugin.saveSettings();
                }));

        new Setting(containerEl)
            .setName('Orphan Threshold')
            .setDesc('Tags used fewer times than this are considered orphaned')
            .addSlider(slider => slider
                .setLimits(1, 10, 1)
                .setValue(this.plugin.settings.orphanThreshold)
                .setDynamicTooltip()
                .onChange(async (value) => {
                    this.plugin.settings.orphanThreshold = value;
                    await this.plugin.saveSettings();
                }));

        new Setting(containerEl)
            .setName('Clear History')
            .setDesc('Remove all operation history')
            .addButton(btn => btn
                .setButtonText('Clear')
                .setWarning()
                .onClick(async () => {
                    this.plugin.settings.operationHistory = [];
                    await this.plugin.saveSettings();
                    new Notice('History cleared.');
                }));
    }

    renderAliases(container: HTMLElement) {
        container.empty();
        const aliases = this.plugin.settings.aliases;

        for (const [alias, canonical] of Object.entries(aliases)) {
            new Setting(container)
                .setName(`#${alias} → #${canonical}`)
                .addButton(btn => btn
                    .setIcon('trash')
                    .setWarning()
                    .onClick(async () => {
                        delete this.plugin.settings.aliases[alias];
                        await this.plugin.saveSettings();
                        this.renderAliases(container);
                    }));
        }

        const addRow = container.createDiv({ cls: 'btm-add-alias' });
        const aliasInput = new TextComponent(addRow).setPlaceholder('alias');
        const canonicalInput = new TextComponent(addRow).setPlaceholder('canonical');
        const addBtn = addRow.createEl('button', { text: 'Add' });
        addBtn.onclick = async () => {
            const a = aliasInput.getValue().replace(/^#/, '');
            const c = canonicalInput.getValue().replace(/^#/, '');
            if (a && c) {
                this.plugin.settings.aliases[a] = c;
                await this.plugin.saveSettings();
                this.renderAliases(container);
            }
        };
    }
}

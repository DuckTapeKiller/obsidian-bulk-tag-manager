import { App, Modal, Notice, Plugin, PluginSettingTab, Setting, TFile, TextComponent, SuggestModal, TFolder, setIcon } from 'obsidian';

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
        lowercase: number;
        uppercase: number;
        mixed: number;
        consistency: number;
    };
    separatorStats: {
        underscore: number;
        hyphen: number;
        both: number;
        none: number;
        consistency: number;
    };
    specialCharStats: {
        withSpecial: number;
        clean: number;
        consistency: number;
    };
    nestingStats: {
        nested: number;
        flat: number;
        maxDepth: number;
    };
    lengthStats: {
        short: number;
        medium: number;
        long: number;
        avgLength: number;
    };
}

interface TagLowercaseSettings {
    caseStrategy: 'lowercase' | 'uppercase' | 'none';
    separatorStrategy: 'preserve' | 'snake' | 'kebab';
    removeSpecialChars: boolean;
    applyToNestedTags: boolean;
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

    analyzeTagStandardization(): TagStandardizationStats {
        const tags = Object.keys(this.app.metadataCache.getTags() || {});
        const totalTags = tags.length;

        if (totalTags === 0) {
            return {
                totalTags: 0,
                caseStats: { lowercase: 0, uppercase: 0, mixed: 0, consistency: 100 },
                separatorStats: { underscore: 0, hyphen: 0, both: 0, none: 0, consistency: 100 },
                specialCharStats: { withSpecial: 0, clean: 0, consistency: 100 },
                nestingStats: { nested: 0, flat: 0, maxDepth: 0 },
                lengthStats: { short: 0, medium: 0, long: 0, avgLength: 0 }
            };
        }

        // Case analysis
        let lowercase = 0, uppercase = 0, mixedCase = 0;

        // Separator analysis
        let underscore = 0, hyphen = 0, bothSeparators = 0, noSeparator = 0;

        // Special character analysis (non-alphanumeric except _ - /)
        let withSpecial = 0, clean = 0;

        // Nesting analysis
        let nested = 0, flat = 0;
        let maxDepth = 0;

        // Length analysis
        let short = 0, medium = 0, long = 0;
        let totalLength = 0;

        for (const tag of tags) {
            const rawTag = tag.startsWith('#') ? tag.substring(1) : tag;

            // Case check (ignore non-letter chars)
            const letters = rawTag.replace(/[^a-zA-Z]/g, '');
            if (letters.length > 0) {
                const isAllLower = letters === letters.toLowerCase();
                const isAllUpper = letters === letters.toUpperCase();
                if (isAllLower && !isAllUpper) lowercase++;
                else if (isAllUpper && !isAllLower) uppercase++;
                else mixedCase++;
            } else {
                lowercase++; // No letters = count as consistent
            }

            // Separator check
            const hasUnderscore = rawTag.includes('_');
            const hasHyphen = rawTag.includes('-');
            if (hasUnderscore && hasHyphen) bothSeparators++;
            else if (hasUnderscore) underscore++;
            else if (hasHyphen) hyphen++;
            else noSeparator++;

            // Special character check (anything that's not alphanumeric, _, -, /)
            const hasSpecial = /[^a-zA-Z0-9_\-\/]/.test(rawTag);
            if (hasSpecial) withSpecial++;
            else clean++;

            // Nesting check
            const depth = (rawTag.match(/\//g) || []).length + 1;
            if (depth > 1) nested++;
            else flat++;
            maxDepth = Math.max(maxDepth, depth);

            // Length check
            totalLength += rawTag.length;
            if (rawTag.length <= 10) short++;
            else if (rawTag.length <= 25) medium++;
            else long++;
        }

        // Calculate consistency percentages
        const dominantCase = Math.max(lowercase, uppercase, mixedCase);
        const caseConsistency = totalTags > 0 ? Math.round((dominantCase / totalTags) * 100) : 100;

        const separatorCounts = [underscore, hyphen, noSeparator];
        const dominantSeparator = Math.max(...separatorCounts);
        const separatorConsistency = totalTags > 0 ? Math.round(((dominantSeparator + (bothSeparators === 0 ? 0 : 0)) / totalTags) * 100) : 100;

        const specialConsistency = totalTags > 0 ? Math.round((clean / totalTags) * 100) : 100;

        return {
            totalTags,
            caseStats: {
                lowercase,
                uppercase,
                mixed: mixedCase,
                consistency: caseConsistency
            },
            separatorStats: {
                underscore,
                hyphen,
                both: bothSeparators,
                none: noSeparator,
                consistency: separatorConsistency
            },
            specialCharStats: {
                withSpecial,
                clean,
                consistency: specialConsistency
            },
            nestingStats: {
                nested,
                flat,
                maxDepth
            },
            lengthStats: {
                short,
                medium,
                long,
                avgLength: Math.round(totalLength / totalTags)
            }
        };
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

    constructor(app: App, plugin: TagLowercasePlugin) {
        super(app);
        this.plugin = plugin;
    }

    onOpen() {
        const { contentEl } = this;
        contentEl.empty();
        contentEl.addClass('btm-dashboard');

        new Setting(contentEl).setName('Bulk Tag Manager').setHeading();

        // Stats Section
        this.statsEl = contentEl.createDiv({ cls: 'btm-stats' });
        this.updateStats();

        // --- Rename Section ---
        contentEl.createEl('hr');
        new Setting(contentEl).setName('Rename Tag').setHeading();

        const renameContainer = contentEl.createDiv({ cls: 'btm-input-row' });

        const findDiv = renameContainer.createDiv({ cls: 'btm-input-group' });
        findDiv.createEl('label', { text: 'Find' });
        this.findInput = new TextComponent(findDiv).setPlaceholder('#old-tag');
        const findSuggestBtn = findDiv.createEl('button', { cls: 'btm-suggest-btn btm-icon-btn' });
        setIcon(findSuggestBtn, 'search');
        const tagCountDisplay = findDiv.createDiv({ cls: 'btm-tag-count-display' });

        findSuggestBtn.onclick = () => new TagSuggest(this.app, this.plugin, (t) => {
            this.findInput.setValue(t);
            const tags = this.plugin.app.metadataCache.getTags() || {};
            const count = tags['#' + t] || 0;
            tagCountDisplay.textContent = `${count} occurrence${count === 1 ? '' : 's'}`;
        }).open();

        const replaceDiv = renameContainer.createDiv({ cls: 'btm-input-group' });
        replaceDiv.createEl('label', { text: 'Replace' });
        this.replaceInput = new TextComponent(replaceDiv).setPlaceholder('#new-tag');

        const btnRename = renameContainer.createEl('button', { text: 'Rename', cls: 'mod-cta' });
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
        contentEl.createEl('hr');
        new Setting(contentEl).setName('Merge Tags').setDesc('Combine multiple tags into one').setHeading();

        const mergeContainer = contentEl.createDiv({ cls: 'btm-input-row' });

        const sourcesDiv = mergeContainer.createDiv({ cls: 'btm-input-group btm-wide' });
        sourcesDiv.createEl('label', { text: 'Source tags' });
        this.mergeSourcesInput = new TextComponent(sourcesDiv).setPlaceholder('#tag1, #tag2, #tag3');
        const selectTagsBtn = sourcesDiv.createEl('button', { cls: 'btm-suggest-btn btm-icon-btn' });
        setIcon(selectTagsBtn, 'list-filter');
        selectTagsBtn.createSpan({ text: ' Select' });
        selectTagsBtn.onclick = () => new MultiTagSelectModal(this.app, this.plugin, (tags) => {
            this.mergeSourcesInput.setValue(tags.map(t => '#' + t).join(', '));
        }).open();

        const targetDiv = mergeContainer.createDiv({ cls: 'btm-input-group' });
        targetDiv.createEl('label', { text: 'Target' });
        this.mergeTargetInput = new TextComponent(targetDiv).setPlaceholder('#merged');
        const targetSuggestBtn = targetDiv.createEl('button', { cls: 'btm-suggest-btn btm-icon-btn' });
        setIcon(targetSuggestBtn, 'search');
        targetSuggestBtn.onclick = () => new TagSuggest(this.app, this.plugin, (t) => this.mergeTargetInput.setValue(t)).open();

        const btnMerge = mergeContainer.createEl('button', { text: 'Merge', cls: 'mod-cta' });
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
        contentEl.createEl('hr');
        new Setting(contentEl).setName('Pattern Rename').setDesc('Use regex to rename tags').setHeading();

        const patternContainer = contentEl.createDiv({ cls: 'btm-input-row' });

        const patternDiv = patternContainer.createDiv({ cls: 'btm-input-group' });
        patternDiv.createEl('label', { text: 'Pattern (regex)' });
        this.patternInput = new TextComponent(patternDiv).setPlaceholder('^old-(.*)');

        const patternReplaceDiv = patternContainer.createDiv({ cls: 'btm-input-group' });
        patternReplaceDiv.createEl('label', { text: 'Replacement' });
        this.patternReplaceInput = new TextComponent(patternReplaceDiv).setPlaceholder('new-$1');

        const btnPattern = patternContainer.createEl('button', { text: 'Apply', cls: 'mod-cta' });
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
        contentEl.createEl('hr');
        new Setting(contentEl).setName('Bulk Conversion Settings').setHeading();

        new Setting(contentEl)
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

        new Setting(contentEl)
            .setName('Separator Style')
            .addDropdown(dropdown => dropdown
                .addOption('preserve', 'Preserve')
                .addOption('snake', 'Snake Case (- → _)')
                .addOption('kebab', 'Kebab Case (_ → -)')
                .setValue(this.plugin.settings.separatorStrategy)
                .onChange(async (value: TagLowercaseSettings['separatorStrategy']) => {
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

        // --- Scope Filter ---
        contentEl.createEl('hr');
        new Setting(contentEl).setName('Scope Filter').setHeading();

        new Setting(contentEl)
            .setName('Enable Scope Filter')
            .setDesc('Limit operations to specific folders')
            .addToggle(toggle => toggle
                .setValue(this.plugin.settings.scopeFilter.enabled)
                .onChange(async (value) => {
                    this.plugin.settings.scopeFilter.enabled = value;
                    await this.plugin.saveSettings();
                    this.updateStats();
                }));

        // Include Folders with select button
        const includeContainer = contentEl.createDiv({ cls: 'btm-scope-row' });
        includeContainer.createEl('label', { text: 'Include Folders:' });
        const includeDisplay = includeContainer.createDiv({ cls: 'btm-folder-display' });
        includeDisplay.textContent = this.plugin.settings.scopeFilter.includeFolders.join(', ') || '(all folders)';
        const includeBtn = includeContainer.createEl('button', { cls: 'btm-suggest-btn btm-icon-btn' });
        setIcon(includeBtn, 'folder-plus');
        includeBtn.createSpan({ text: ' Select' });
        includeBtn.onclick = () => new FolderSelectModal(
            this.app,
            this.plugin,
            this.plugin.settings.scopeFilter.includeFolders,
            async (folders) => {
                this.plugin.settings.scopeFilter.includeFolders = folders;
                await this.plugin.saveSettings();
                includeDisplay.textContent = folders.join(', ') || '(all folders)';
                this.updateStats();
            }
        ).open();

        // Exclude Folders with select button
        const excludeContainer = contentEl.createDiv({ cls: 'btm-scope-row' });
        excludeContainer.createEl('label', { text: 'Exclude Folders:' });
        const excludeDisplay = excludeContainer.createDiv({ cls: 'btm-folder-display' });
        excludeDisplay.textContent = this.plugin.settings.scopeFilter.excludeFolders.join(', ') || '(none)';
        const excludeBtn = excludeContainer.createEl('button', { cls: 'btm-suggest-btn btm-icon-btn' });
        setIcon(excludeBtn, 'folder-minus');
        excludeBtn.createSpan({ text: ' Select' });
        excludeBtn.onclick = () => new FolderSelectModal(
            this.app,
            this.plugin,
            this.plugin.settings.scopeFilter.excludeFolders,
            async (folders) => {
                this.plugin.settings.scopeFilter.excludeFolders = folders;
                await this.plugin.saveSettings();
                excludeDisplay.textContent = folders.join(', ') || '(none)';
                this.updateStats();
            }
        ).open();

        // --- Actions ---
        contentEl.createEl('hr');
        const actionRow = contentEl.createDiv({ cls: 'btm-action-row' });

        const btnConvert = this.createIconButton(actionRow, 'refresh-cw', 'Convert All', 'mod-cta');
        btnConvert.onclick = async () => {
            this.close();
            await this.plugin.runConversionWithPreview();
        };

        const btnList = this.createIconButton(actionRow, 'list', 'Tag List');
        btnList.onclick = async () => {
            this.close();
            await this.plugin.generateTagList();
        };

        const btnHierarchy = this.createIconButton(actionRow, 'git-branch', 'Hierarchy');
        btnHierarchy.onclick = () => {
            this.close();
            new TagHierarchyModal(this.app, this.plugin).open();
        };

        const btnOrphans = this.createIconButton(actionRow, 'alert-circle', 'Orphans');
        btnOrphans.onclick = () => {
            this.close();
            new OrphanTagsModal(this.app, this.plugin).open();
        };

        const btnHistory = this.createIconButton(actionRow, 'history', 'History');
        btnHistory.onclick = () => {
            this.close();
            new HistoryModal(this.app, this.plugin).open();
        };
    }

    createIconButton(container: HTMLElement, iconName: string, text: string, cls: string = ''): HTMLButtonElement {
        const btn = container.createEl('button', { cls: `btm-icon-btn ${cls}`.trim() });
        const iconEl = btn.createSpan({ cls: 'btm-btn-icon' });
        setIcon(iconEl, iconName);
        btn.createSpan({ text: ' ' + text });
        return btn;
    }

    updateStats() {
        this.statsEl.empty();
        this.statsEl.addClass('btm-standardization-panel');

        const stats = this.plugin.analyzeTagStandardization();
        const files = this.plugin.getFilteredFiles();

        // Header stats
        const headerRow = this.statsEl.createDiv({ cls: 'btm-stats-header' });
        const tagsItem = headerRow.createSpan({ cls: 'btm-stat-item' });
        setIcon(tagsItem.createSpan({ cls: 'btm-stat-icon' }), 'tags');
        tagsItem.createSpan({ text: ` ${stats.totalTags} tags` });

        const filesItem = headerRow.createSpan({ cls: 'btm-stat-item' });
        setIcon(filesItem.createSpan({ cls: 'btm-stat-icon' }), 'files');
        filesItem.createSpan({ text: ` ${files.length} files` });

        // Standardization metrics
        const metricsGrid = this.statsEl.createDiv({ cls: 'btm-metrics-grid' });

        // Case consistency
        const caseBox = metricsGrid.createDiv({ cls: 'btm-metric-box' });
        caseBox.createDiv({ text: 'Case', cls: 'btm-metric-label' });
        this.createProgressBar(caseBox, stats.caseStats.consistency);
        const caseDetails = caseBox.createDiv({ cls: 'btm-metric-details' });
        if (stats.caseStats.lowercase > 0) caseDetails.createSpan({ text: `${stats.caseStats.lowercase} lower` });
        if (stats.caseStats.uppercase > 0) caseDetails.createSpan({ text: `${stats.caseStats.uppercase} UPPER` });
        if (stats.caseStats.mixed > 0) caseDetails.createSpan({ text: `${stats.caseStats.mixed} Mixed` });

        // Separator consistency
        const sepBox = metricsGrid.createDiv({ cls: 'btm-metric-box' });
        sepBox.createDiv({ text: 'Separators', cls: 'btm-metric-label' });
        this.createProgressBar(sepBox, stats.separatorStats.consistency);
        const sepDetails = sepBox.createDiv({ cls: 'btm-metric-details' });
        if (stats.separatorStats.hyphen > 0) sepDetails.createSpan({ text: `${stats.separatorStats.hyphen} kebab-case` });
        if (stats.separatorStats.underscore > 0) sepDetails.createSpan({ text: `${stats.separatorStats.underscore} snake_case` });
        if (stats.separatorStats.both > 0) sepDetails.createSpan({ text: `${stats.separatorStats.both} mixed` });
        if (stats.separatorStats.none > 0) sepDetails.createSpan({ text: `${stats.separatorStats.none} none` });

        // Special characters
        const specialBox = metricsGrid.createDiv({ cls: 'btm-metric-box' });
        specialBox.createDiv({ text: 'Clean Tags', cls: 'btm-metric-label' });
        this.createProgressBar(specialBox, stats.specialCharStats.consistency);
        const specialDetails = specialBox.createDiv({ cls: 'btm-metric-details' });
        specialDetails.createSpan({ text: `${stats.specialCharStats.clean} clean` });
        if (stats.specialCharStats.withSpecial > 0) {
            specialDetails.createSpan({ text: `${stats.specialCharStats.withSpecial} with special chars` });
        }

        // Nesting stats
        const nestBox = metricsGrid.createDiv({ cls: 'btm-metric-box' });
        nestBox.createDiv({ text: 'Structure', cls: 'btm-metric-label' });
        const nestDetails = nestBox.createDiv({ cls: 'btm-metric-details' });
        nestDetails.createSpan({ text: `${stats.nestingStats.flat} flat` });
        nestDetails.createSpan({ text: `${stats.nestingStats.nested} nested` });
        if (stats.nestingStats.maxDepth > 1) {
            nestDetails.createSpan({ text: `max depth: ${stats.nestingStats.maxDepth}` });
        }

        // Length stats
        const lengthBox = metricsGrid.createDiv({ cls: 'btm-metric-box' });
        lengthBox.createDiv({ text: 'Length', cls: 'btm-metric-label' });
        const lengthDetails = lengthBox.createDiv({ cls: 'btm-metric-details' });
        lengthDetails.createSpan({ text: `avg: ${stats.lengthStats.avgLength} chars` });
        if (stats.lengthStats.long > 0) {
            lengthDetails.createSpan({ text: `${stats.lengthStats.long} long (>25)` });
        }
    }

    createProgressBar(container: HTMLElement, percentage: number) {
        const barContainer = container.createDiv({ cls: 'btm-progress-container' });
        const bar = barContainer.createDiv({ cls: 'btm-progress-bar' });
        bar.style.width = `${percentage}%`;

        // Color based on percentage
        if (percentage >= 90) bar.addClass('btm-progress-good');
        else if (percentage >= 70) bar.addClass('btm-progress-ok');
        else bar.addClass('btm-progress-warn');

        barContainer.createSpan({ text: `${percentage}%`, cls: 'btm-progress-label' });
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

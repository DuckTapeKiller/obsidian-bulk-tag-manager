import { App, Modal, Notice, Plugin, PluginSettingTab, Setting, TFile, TextComponent, DropdownComponent, SuggestModal, TFolder, setIcon, setTooltip } from 'obsidian';

// --- Interfaces ---

interface OperationRecord {
    id: string;
    timestamp: number;
    type: string;
    description: string;
    changes: { path: string }[];
    useExternalStorage?: boolean;
    useExternalManifest?: boolean;
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
    formatStats: {
        yamlList: TFile[];
        inlineArray: TFile[];
        mixed: TFile[];
    };

    inlineFiles: { file: TFile; count: number; tags: string[] }[];
    nestedFiles: { file: TFile; count: number; tags: string[] }[];
    quotedFrontmatterCount: number;
    quotedFrontmatterFiles: TFile[];
}

interface InvalidTagFile {
    path: string;
    file: TFile;
    issues: { description: string; tag?: string }[];
}

interface TagLowercaseSettings {
    caseStrategy: 'lowercase' | 'uppercase' | 'none';
    separatorStrategy: 'preserve' | 'snake' | 'kebab';
    removeSpecialChars: boolean;
    flattenDiacritics: boolean;
    applyToNestedTags: boolean;
    tagFormat: 'inline' | 'list';
    aliases: Record<string, string>;
    operationHistory: OperationRecord[];
    scopeFilter: ScopeFilter;
    orphanThreshold: number;
    maxHistorySize: number;
    historyExpirationDays: number;
    ignoredIssues: string[];
}

const DEFAULT_SETTINGS: TagLowercaseSettings = {
    caseStrategy: 'lowercase',
    separatorStrategy: 'preserve',
    removeSpecialChars: false,
    flattenDiacritics: false,
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
    maxHistorySize: 50,
    historyExpirationDays: 7,
    ignoredIssues: []
};

// Improved regex that skips code blocks
const TAG_REGEX = /(^|\s)(#[\p{L}\p{N}_\-\/]+)/gu;

export default class TagLowercasePlugin extends Plugin {
    settings: TagLowercaseSettings;

    async onload() {
        await this.loadSettings();
        await this.purgeExpiredHistory();

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
            callback: async () => {
                await this.loadSettings(); // Reload settings before running
                this.runConversionWithPreview();
            }
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

    onunload() {
        for (const timer of this.aliasDebounceTimers.values()) {
            clearTimeout(timer);
        }
        this.aliasDebounceTimers.clear();
    }

    private aliasDebounceTimers: Map<string, ReturnType<typeof setTimeout>> = new Map();

    applyAliasesDebounced(file: TFile) {
        const existingTimer = this.aliasDebounceTimers.get(file.path);
        if (existingTimer) clearTimeout(existingTimer);
        
        const timer = setTimeout(() => {
            this.applyAliases(file);
            this.aliasDebounceTimers.delete(file.path);
        }, 1000);
        
        this.aliasDebounceTimers.set(file.path, timer);
    }

    async loadSettings() {
        const loaded = await this.loadData() || {};
        this.settings = {
            ...DEFAULT_SETTINGS,
            ...loaded,
            scopeFilter: { 
                ...DEFAULT_SETTINGS.scopeFilter, 
                ...(loaded.scopeFilter || {}) 
            },
            aliases: {
                ...DEFAULT_SETTINGS.aliases,
                ...(loaded.aliases || {})
            }
        };
    }

    async saveSettings() {
        await this.saveData(this.settings);
    }

    // --- File Filtering ---

    getFilteredFiles(): TFile[] {
        let files = this.app.vault.getMarkdownFiles();

        if (!this.settings.scopeFilter.enabled) return files;

        const { includeFolders, excludeFolders, filePattern } = this.settings.scopeFilter;

        const normalizeFolder = (f: string) => f.endsWith('/') ? f : f + '/';

        if (includeFolders.length > 0) {
            const normalizedIncludes = includeFolders.map(normalizeFolder);
            files = files.filter(f => normalizedIncludes.some(folder => f.path.startsWith(folder) || f.path === folder.slice(0, -1)));
        }

        if (excludeFolders.length > 0) {
            const normalizedExcludes = excludeFolders.map(normalizeFolder);
            files = files.filter(f => !normalizedExcludes.some(folder => f.path.startsWith(folder) || f.path === folder.slice(0, -1)));
        }

        if (filePattern) {
            // Issue 12: Basic ReDoS protection
            if (filePattern.length > 100 || (filePattern.match(/(\+|\*|\?)\1+/g) || []).length > 3) {
                console.warn('File pattern is too complex, skipping regex filter.');
            } else {
                try {
                    const regex = new RegExp(filePattern);
                    files = files.filter(f => regex.test(f.path));
                } catch { /* invalid regex, ignore */ }
            }
        }

        return files;
    }

    // --- History Management ---

    async addToHistory(record: Omit<OperationRecord, 'id' | 'timestamp' | 'changes'> & { changes: FileChange[] }) {
        const operationId = crypto.randomUUID();
        const fullRecord: OperationRecord = {
            id: operationId,
            timestamp: Date.now(),
            type: record.type,
            description: record.description,
            changes: record.changes.map(c => ({ path: c.path })),
            useExternalStorage: true
        };

        // External Storage Implementation
        try {
            const historyDir = `${this.app.vault.configDir}/plugins/bulk-tag-manager/history/${operationId}`;
            await this.app.vault.adapter.mkdir(historyDir);

            for (let i = 0; i < record.changes.length; i++) {
                const change = record.changes[i];
                // Store both before and after for completeness
                await this.app.vault.adapter.write(`${historyDir}/${i}.before`, change.before);
                await this.app.vault.adapter.write(`${historyDir}/${i}.after`, change.after);
            }

            // Save the manifest (file paths) externally
            const manifest = record.changes.map(c => ({ path: c.path }));
            await this.app.vault.adapter.write(`${historyDir}/manifest.json`, JSON.stringify(manifest));
            fullRecord.useExternalManifest = true;
            fullRecord.changes = []; // Clear paths from data.json
        } catch (e) {
            console.error('Failed to save external history snapshots:', e);
            new Notice('Warning: Failed to save history snapshots. This operation may not be reversible.');
            (fullRecord as any).nonRevertible = true;
        }

        this.settings.operationHistory.unshift(fullRecord);

        // 1. Cap by length
        if (this.settings.operationHistory.length > this.settings.maxHistorySize) {
            const removed = this.settings.operationHistory.splice(this.settings.maxHistorySize);
            for (const oldOp of removed) {
                await this.deleteExternalHistory(oldOp.id);
            }
        }

        // 2. Cap by total JSON size (though data.json is now much smaller)
        let totalSize = JSON.stringify(this.settings.operationHistory).length;
        while (totalSize > 2_000_000 && this.settings.operationHistory.length > 0) {
            const oldOp = this.settings.operationHistory.pop();
            if (oldOp) await this.deleteExternalHistory(oldOp.id);
            totalSize = JSON.stringify(this.settings.operationHistory).length;
        }

        // 3. Purge by age
        await this.purgeExpiredHistory();

        await this.saveSettings();
    }

    async purgeExpiredHistory() {
        if (this.settings.historyExpirationDays <= 0) return;

        const cutoff = Date.now() - (this.settings.historyExpirationDays * 24 * 60 * 60 * 1000);
        const toKeep = [];
        const toDelete = [];

        for (const op of this.settings.operationHistory) {
            if (op.timestamp >= cutoff) {
                toKeep.push(op);
            } else {
                toDelete.push(op);
            }
        }

        if (toDelete.length > 0) {
            for (const op of toDelete) {
                await this.deleteExternalHistory(op.id);
            }
            this.settings.operationHistory = toKeep;
            await this.saveSettings();
            console.log(`BTM: Purged ${toDelete.length} expired history records.`);
        }
    }

    async deleteExternalHistory(id: string) {
        try {
            const historyDir = `${this.app.vault.configDir}/plugins/bulk-tag-manager/history/${id}`;
            if (await this.app.vault.adapter.exists(historyDir)) {
                await this.app.vault.adapter.rmdir(historyDir, true);
            }
        } catch (e) {
            console.error(`Failed to delete external history ${id}:`, e);
        }
    }

    async undoLastOperation() {
        if (this.settings.operationHistory.length === 0) {
            new Notice('No operations to undo.');
            return;
        }

        const lastOp = this.settings.operationHistory[0];
        let revertedCount = 0;

        new Notice(`Reverting: ${lastOp.description}...`);

        if ((lastOp as any).nonRevertible) {
            new Notice('This operation cannot be reverted (snapshots missing).');
            return;
        }

        const historyDir = `${this.app.vault.configDir}/plugins/bulk-tag-manager/history/${lastOp.id}`;
        let fileChanges = lastOp.changes;

        // Load manifest if stored externally
        if (lastOp.useExternalManifest) {
            try {
                const manifestPath = `${historyDir}/manifest.json`;
                if (await this.app.vault.adapter.exists(manifestPath)) {
                    fileChanges = JSON.parse(await this.app.vault.adapter.read(manifestPath));
                } else {
                    new Notice('Critical error: History manifest missing.');
                    return;
                }
            } catch (e) {
                console.error('Failed to load history manifest:', e);
                new Notice('Failed to load history manifest.');
                return;
            }
        }

        for (let i = 0; i < fileChanges.length; i++) {
            const change = fileChanges[i];
            const file = this.app.vault.getAbstractFileByPath(change.path);
            
            if (file instanceof TFile) {
                try {
                    let beforeContent: string;
                    if (lastOp.useExternalStorage) {
                        const snapshotPath = `${historyDir}/${i}.before`;
                        if (await this.app.vault.adapter.exists(snapshotPath)) {
                            beforeContent = await this.app.vault.adapter.read(snapshotPath);
                        } else {
                            console.warn(`Snapshot missing for ${change.path}`);
                            continue;
                        }
                    } else {
                        // Support legacy snapshots (if any still exist)
                        beforeContent = (change as any).before;
                    }

                    if (beforeContent && beforeContent !== '(Snapshot omitted due to size)') {
                        await this.app.vault.modify(file, beforeContent);
                        revertedCount++;
                    }
                } catch (e) {
                    console.error(`Failed to revert ${change.path}:`, e);
                }
            }
        }

        // Cleanup
        if (lastOp.useExternalStorage) {
            await this.deleteExternalHistory(lastOp.id);
        }

        this.settings.operationHistory.shift();
        await this.saveSettings();

        new Notice(`Reverted ${revertedCount} files.`);
    }

    async standardiseProperties() {
        const files = this.getFilteredFiles();
        if (files.length === 0) {
            new Notice('No markdown files found in current scope.');
            return;
        }

        new BtmConfirmationModal(
            this.app,
            'Clean Frontmatter Formatting',
            `Are you sure you want to standardise properties across ${files.length} files? This will remove unnecessary quotes and trim whitespace from all fields.`,
            async () => {
                const progressModal = new ProgressModal(this.app, files.length);
                progressModal.open();
                let successCount = 0;
                let attemptCount = 0;
                const errors: { path: string; message: string }[] = [];

                for (const file of files) {
                    attemptCount++;
                    try {
                        await this.app.fileManager.processFrontMatter(file, (fm) => {
                            const processValue = (val: any): any => {
                                if (typeof val === 'string') return val.trim();
                                if (Array.isArray(val)) return val.map(v => processValue(v));
                                
                                // Recursive walk for nested objects, excluding Dates
                                if (val !== null && typeof val === 'object' && !(val instanceof Date)) {
                                    for (const k in val) val[k] = processValue(val[k]);
                                }
                                return val;
                            };

                            for (const key in fm) {
                                fm[key] = processValue(fm[key]);
                            }
                        });
                        successCount++;
                    } catch (e) {
                        const errorMsg = e instanceof Error ? e.message : String(e);
                        console.error(`Standardise failed for ${file.path}:`, errorMsg);
                        errors.push({ path: file.path, message: errorMsg });
                    }

                    // Throttle: Yield to event loop every 50 files based on attempts
                    if (attemptCount % 50 === 0) {
                        progressModal.update(attemptCount);
                        await new Promise(resolve => setTimeout(resolve, 5)); 
                    } else {
                        progressModal.update(attemptCount);
                    }
                }

                progressModal.close();
                new Notice(`Finished: ${successCount} files cleaned. ${errors.length > 0 ? `(${errors.length} skipped due to errors)` : ''}`);
                
                if (errors.length > 0) {
                    new BtmErrorReportModal(this.app, this, 'Standardise Errors', errors).open();
                }
            }
        ).open();
    }

    async fixInvalidMappingError(file: TFile): Promise<void> {
        // 1. Read raw text from disk (bypasses parser)
        const content = await this.app.vault.read(file);
        const fmMatch = content.match(/^---\n([\s\S]*?)\n---/);

        if (!fmMatch) return;

        const originalFm = fmMatch[1];
        const lines = originalFm.split('\n');
        let isModified = false;

        const fixedLines = lines.map(line => {
            // Regex targets lines like: Key: Text with a: inside
            // Group 1: The Key (e.g., "Resumen")
            // Group 2: The invalid unquoted value (contains : )
            // Negative lookahead ensures we do not touch already quoted or complex lines.
            const match = line.match(/^([\w\s_-]+):\s*(?!["'\[{>|])(.*:\s.*)$/);

            if (match) {
                const key = match[1];
                let value = match[2];

                // Escape any existing double quotes inside the string
                value = value.replace(/"/g, '\\"');

                isModified = true;
                return `${key}: "${value}"`;
            }

            return line;
        });

        if (isModified) {
            const newFm = fixedLines.join('\n');
            const newContent = content.replace(originalFm, newFm);
            await this.app.vault.modify(file, newContent);
        }
    }

    // --- Preview System ---

    async previewConversion(): Promise<PreviewResult> {
        const files = this.getFilteredFiles();
        const affectedFiles: PreviewFile[] = [];
        for (const file of files) {
            const content = await this.app.vault.read(file);
            const newContent = this.transformContent(content);
            const changes: { line: number; before: string; after: string }[] = [];

            if (content !== newContent) {
                changes.push(...this.diffContent(content, newContent));
            }

            // Always check frontmatter independently
            const cache = this.app.metadataCache.getFileCache(file);
            if (cache?.frontmatter) {
                let fmModified = false;
                const checkTag = (t: string) => {
                    const clean = t.startsWith('#') ? t.substring(1) : t;
                    const converted = this.convertTagContent(clean);
                    const final = t.startsWith('#') ? '#' + converted : converted;
                    if (final !== t) fmModified = true;
                };

                const fm = cache.frontmatter;
                if (fm.tags) {
                    if (Array.isArray(fm.tags)) fm.tags.forEach((t: any) => typeof t === 'string' && checkTag(t));
                    else if (typeof fm.tags === 'string') checkTag(fm.tags);
                }
                if (fm.tag) {
                    if (Array.isArray(fm.tag)) fm.tag.forEach((t: any) => typeof t === 'string' && checkTag(t));
                    else if (typeof fm.tag === 'string') checkTag(fm.tag);
                }

                if (fmModified) {
                    // We can't easily preview exact YAML changes without writing, so we add a generic notice
                    changes.push({ line: 1, before: '(Frontmatter tags)', after: '(Will be standardized)' });
                }
            }

            if (changes.length > 0) {
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
                const after = await this.processFile(file);

                if (before !== after) {
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
                const after = await this.processFile(file);

                if (before !== after) {
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
                type: 'convert',
                description: `Bulk conversion (${changes.length} files)`,
                changes
            });
        }

        new Notice(`Processed ${processedCount} files.`);
    }

    async generateTagList() {
        const tags = (this.app.metadataCache as any).getTags();
        if (!tags || Object.keys(tags).length === 0) {
            new Notice('No tags found in vault.');
            return;
        }

        const sortedTags = Object.keys(tags)
            .sort((a, b) => a.localeCompare(b));

        const fileContent = `# All Tags\n\n${sortedTags.join('\n')}\n`;
        const fileName = 'All Tags.md'; // Could be made configurable in settings later

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

    private getCodeBlockRanges(content: string): { start: number; end: number }[] {
        const regex = /```[\s\S]*?```|`[^`\n]+`/g;
        const ranges: { start: number; end: number }[] = [];
        let m;
        while ((m = regex.exec(content)) !== null) {
            ranges.push({ start: m.index, end: m.index + m[0].length });
        }
        return ranges;
    }

    private isInCodeBlockRange(offset: number, ranges: { start: number; end: number }[]): boolean {
        for (const range of ranges) {
            if (offset >= range.start && offset < range.end) return true;
        }
        return false;
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
                    if (typeof t !== 'string') return false;
                    const raw = t.startsWith('#') ? t.substring(1) : t;
                    return raw === search || raw.startsWith(search + '/');
                });
            }
            if (cache?.frontmatter?.tag) {
                const fmTags = Array.isArray(cache.frontmatter.tag)
                    ? cache.frontmatter.tag
                    : [cache.frontmatter.tag];
                hasFrontmatterTag = hasFrontmatterTag || fmTags.some((t: string) => {
                    if (typeof t !== 'string') return false;
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
            tagRegex.lastIndex = 0; // Issue 3: Explicitly reset at start of each iteration
            try {
                const before = await this.app.vault.read(file);
                let modified = false;

                await this.app.fileManager.processFrontMatter(file, (fm) => {
                    const processSingleTag = (t: string): string => {
                        if (typeof t !== 'string') return t;
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

                    // Issue 8: Only assign back if something actually changed
                    if (fm.tags) {
                        if (Array.isArray(fm.tags)) {
                            const newTags = fm.tags.map(processSingleTag);
                            if (newTags.some((t, i) => t !== fm.tags[i])) {
                                fm.tags = newTags;
                            }
                        } else if (typeof fm.tags === 'string') {
                            const newTag = processSingleTag(fm.tags);
                            if (newTag !== fm.tags) fm.tags = newTag;
                        }
                    }
                    if (fm.tag) {
                        if (Array.isArray(fm.tag)) {
                            const newTags = fm.tag.map(processSingleTag);
                            if (newTags.some((t, i) => t !== fm.tag[i])) {
                                fm.tag = newTags;
                            }
                        } else if (typeof fm.tag === 'string') {
                            const newTag = processSingleTag(fm.tag);
                            if (newTag !== fm.tag) fm.tag = newTag;
                        }
                    }
                });

                let after = before;
                await this.app.vault.process(file, (data) => {
                    const codeBlockRanges = this.getCodeBlockRanges(data);
                    const newData = data.replace(tagRegex, (m, prefix, hash, captured, offset) => {
                        if (this.isInCodeBlockRange(offset, codeBlockRanges)) return m;
                        
                        modified = true;
                        return prefix + hash + replace;
                    });
                    tagRegex.lastIndex = 0; // Reset regex state
                    after = newData;
                    return newData;
                });

                if (modified) {
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

        const files = this.getFilteredFiles();
        const changes: FileChange[] = [];

        // Validation: Every single source tag must exist in the current scope
        const tagsInScope = new Set<string>();
        for (const file of files) {
            const cache = this.app.metadataCache.getFileCache(file);
            if (cache?.tags) {
                cache.tags.forEach(t => tagsInScope.add(t.tag.startsWith('#') ? t.tag.substring(1) : t.tag));
            }
            if (cache?.frontmatter) {
                const extract = (val: any) => {
                    if (typeof val === 'string') val.split(',').forEach(v => tagsInScope.add(v.trim().startsWith('#') ? v.trim().substring(1) : v.trim()));
                    else if (Array.isArray(val)) val.forEach(v => typeof v === 'string' && tagsInScope.add(v.startsWith('#') ? v.substring(1) : v));
                };
                if (cache.frontmatter.tags) extract(cache.frontmatter.tags);
                if (cache.frontmatter.tag) extract(cache.frontmatter.tag);
            }
        }

        const missingTags: string[] = [];
        for (const s of sourcesClean) {
            if (!tagsInScope.has(s)) {
                missingTags.push('#' + s);
            }
        }

        if (missingTags.length > 0) {
            new Notice(`Merge aborted: ${missingTags.join(', ')} not found in current scope. Check for typos or scope filters.`);
            return;
        }

        new Notice(`Merging ${sourcesClean.length} tags into #${targetClean}...`);

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
                        if (typeof t !== 'string') return t;
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

                    // Issue 8: Only assign back if something actually changed
                    const handleTagKey = (key: string) => {
                        if (fm[key]) {
                            if (Array.isArray(fm[key])) {
                                const newTags = fm[key].map(processSingleTag);
                                // Deduplicate
                                const uniqueTags = [];
                                const seen = new Set();
                                for (const t of newTags) {
                                    const clean = typeof t === 'string' && t.startsWith('#') ? t.substring(1) : t;
                                    if (!seen.has(clean)) {
                                        seen.add(clean);
                                        uniqueTags.push(t);
                                    }
                                }
                                
                                if (uniqueTags.length !== fm[key].length || uniqueTags.some((t, i) => t !== fm[key][i])) {
                                    fm[key] = uniqueTags;
                                    modified = true;
                                }
                            } else if (typeof fm[key] === 'string') {
                                const newTag = processSingleTag(fm[key]);
                                if (newTag !== fm[key]) {
                                    fm[key] = newTag;
                                    modified = true;
                                }
                            }
                        }
                    };

                    handleTagKey('tags');
                    handleTagKey('tag');
                });

                let after = before;
                await this.app.vault.process(file, (data) => {
                    const codeBlockRanges = this.getCodeBlockRanges(data);
                    let newData = data.replace(tagRegex, (match, prefix, hash, capturedTag, offset) => {
                        if (this.isInCodeBlockRange(offset, codeBlockRanges)) return match;

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
                    
                    // Collapse consecutive identical tags (e.g. #target #target -> #target)
                    // This handles the "merge creates duplicates" issue in the body
                    if (modified) {
                        const targetTagEscaped = escapeRegExp(targetClean);
                        // Matches #target followed by whitespace/punctuation and then #target again
                        const duoRegex = new RegExp(`(#${targetTagEscaped})(\\s*[,;]?\\s*)(#${targetTagEscaped})(?=[\\s,;]|$|[^\\p{L}\\p{N}_-])`, 'gu');
                        let prevData;
                        do {
                            prevData = newData;
                            newData = newData.replace(duoRegex, '$1');
                        } while (newData !== prevData);
                    }

                    tagRegex.lastIndex = 0;
                    after = newData;
                    return newData;
                });

                if (modified) {
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
            new Notice(`Merged ${sourcesClean.length} tags into #${targetClean}. ${changes.length} files changed.`);
        } else {
            new Notice(`No files were modified. (Tags might not exist in the current scope)`);
        }
    }

    async deleteTags(tagsToDelete: string[]) {
        const cleanTags = tagsToDelete
            .map(t => t.startsWith('#') ? t.substring(1) : t)
            .filter(t => t.length > 0);

        if (cleanTags.length === 0) {
            new Notice('No valid tags to delete.');
            return;
        }

        const files = this.getFilteredFiles();
        const changes: FileChange[] = [];

        new Notice(`Deleting ${cleanTags.length} tags...`);

        const progressModal = new ProgressModal(this.app, files.length);
        progressModal.open();
        let processedCount = 0;

        const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        // Match exact tag OR tag/child
        const patternParts = cleanTags.map(t => `(?:${escapeRegExp(t)}(?:\\/[\\p{L}\\p{N}_\\-]+)*)`);
        const combinedPattern = patternParts.join('|');
        const tagRegex = new RegExp(`(^|\\s)(#)(${combinedPattern})(?=[\\s]|$|[^\\p{L}\\p{N}_-])`, 'gu');

        for (const file of files) {
            try {
                const before = await this.app.vault.read(file);
                let modified = false;

                // Process Frontmatter
                await this.app.fileManager.processFrontMatter(file, (fm) => {
                    const shouldDelete = (t: string) => {
                        const raw = t.startsWith('#') ? t.substring(1) : t;
                        // Check if raw is one of the tags to delete or a child of them
                        return cleanTags.some(del => raw === del || raw.startsWith(del + '/'));
                    };

                    if (fm.tags) {
                        if (Array.isArray(fm.tags)) {
                            const originalLen = fm.tags.length;
                            fm.tags = fm.tags.filter((t: string) => !shouldDelete(t));
                            if (fm.tags.length !== originalLen) modified = true;
                        } else if (typeof fm.tags === 'string') {
                            if (shouldDelete(fm.tags)) {
                                delete fm.tags;
                                modified = true;
                            }
                        }
                    }
                    if (fm.tag) { // handle 'tag' key
                        if (Array.isArray(fm.tag)) {
                            const originalLen = fm.tag.length;
                            fm.tag = fm.tag.filter((t: string) => !shouldDelete(t));
                            if (fm.tag.length !== originalLen) modified = true;
                        } else if (typeof fm.tag === 'string') {
                            if (shouldDelete(fm.tag)) {
                                delete fm.tag;
                                modified = true;
                            }
                        }
                    }
                });

                let after = before;
                await this.app.vault.process(file, (data) => {
                    const codeBlockRanges = this.getCodeBlockRanges(data);
                    const newData = data.replace(tagRegex, (match, prefix, hash, tag, offset) => {
                        if (this.isInCodeBlockRange(offset, codeBlockRanges)) return match;

                        modified = true;
                        return prefix; // Keep the prefix (space/start), remove the tag
                    });
                    after = newData;
                    return newData;
                });

                if (modified) {
                    changes.push({ path: file.path, before, after });
                }

                processedCount++;
                progressModal.update(processedCount);

            } catch (e) {
                console.error(`Failed to delete tags in ${file.path}`, e);
                processedCount++;
                progressModal.update(processedCount);
            }
        }

        progressModal.close();

        if (changes.length > 0) {
            await this.addToHistory({
                type: 'delete',
                description: `Deleted tags: ${cleanTags.join(', ')}`,
                changes
            });
            new Notice(`Deleted tags from ${changes.length} files.`);
        } else {
            new Notice('No tags deleted.');
        }
    }

    async batchRename(pattern: string, replacement: string) {
        const files = this.getFilteredFiles();
        const changes: FileChange[] = [];
        let regex: RegExp;

        // Issue 12: Basic ReDoS protection
        if (pattern.length > 100 || (pattern.match(/(\+|\*|\?)\1+/g) || []).length > 3) {
            new Notice('Regex pattern is too complex. Please simplify.');
            return;
        }

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
            try {
                const before = await this.app.vault.read(file);
                let after = before;
                await this.app.vault.process(file, (data) => {
                    const codeBlockRanges = this.getCodeBlockRanges(data);
                    const newData = data.replace(TAG_REGEX, (fullMatch, prefix, tag, offset) => {
                        if (this.isInCodeBlockRange(offset, codeBlockRanges)) return fullMatch;

                        const clean = tag.substring(1);
                        const newTag = clean.replace(regex, replacement);
                        if (newTag !== clean) {
                            return prefix + '#' + newTag;
                        }
                        return fullMatch;
                    });
                    after = newData;
                    return newData;
                });

                if (before !== after) {
                    changes.push({ path: file.path, before, after });
                }
                
                processedCount++;
                progressModal.update(processedCount);
            } catch (e) {
                console.error(`batchRename failed on ${file.path}`, e);
                processedCount++;
                progressModal.update(processedCount);
            }
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
        const tags = (this.app.metadataCache as any).getTags() || {};
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
                    existingNode.count = count as number;
                }

                currentLevel = existingNode.children;
            }
        }

        // Issue 11: Accumulate counts from children to parents
        const accumulate = (nodes: TagNode[]): number => {
            let total = 0;
            for (const node of nodes) {
                const childrenCount = accumulate(node.children);
                node.count += childrenCount;
                total += node.count;
            }
            return total;
        };
        
        // We don't want the total sum of all roots, just want each root to have its tree sum
        root.forEach(node => {
            const childrenCount = accumulate(node.children);
            node.count += childrenCount;
        });

        return root;
    }

    findOrphanedTags(): { tag: string; count: number }[] {
        const tags = (this.app.metadataCache as any).getTags() || {};
        return Object.entries(tags)
            .filter(([, count]) => (count as number) < this.settings.orphanThreshold)
            .map(([tag, count]) => ({ tag, count: count as number }))
            .sort((a, b) => a.count - b.count);
    }

    async analyzeTagStandardization(files: TFile[]): Promise<TagStandardizationStats> {
        // Issue 10: Scope filter ignored for global tag string stats
        // Derive unique tags only from the provided (filtered) files
        const tagSet = new Set<string>();
        for (const file of files) {
            const cache = this.app.metadataCache.getFileCache(file);
            if (cache?.tags) {
                cache.tags.forEach(t => tagSet.add(t.tag));
            }
            if (cache?.frontmatter) {
                const fm = cache.frontmatter;
                const extractTags = (val: any) => {
                    if (typeof val === 'string') val.split(',').forEach(t => tagSet.add(t.trim().startsWith('#') ? t.trim() : '#' + t.trim()));
                    else if (Array.isArray(val)) val.forEach(t => typeof t === 'string' && tagSet.add(t.startsWith('#') ? t : '#' + t));
                };
                if (fm.tags) extractTags(fm.tags);
                if (fm.tag) extractTags(fm.tag);
            }
        }
        const tags = Array.from(tagSet);
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
            formatStats: { yamlList: [], inlineArray: [], mixed: [] },
            inlineFiles: [],
            nestedFiles: [],
            quotedFrontmatterCount: 0,
            quotedFrontmatterFiles: []
        };

        // Format Analysis (Check all files)
        // Issue 14 optimization: We only need to read the file if we actually have frontmatter tags to analyze
        for (const file of files) {
            const cache = this.app.metadataCache.getFileCache(file);
            if (!cache?.frontmatter) continue;
            
            try {
                // High-speed cached read (avoids disk I/O bottleneck)
                const content = await this.app.vault.cachedRead(file);
                
                if (content.startsWith('---')) {
                    const fmMatch = content.match(/^---\n([\s\S]*?)\n---/);
                    if (fmMatch) {
                        const fmText = fmMatch[1];
                        const lines = fmText.split('\n');
                        
                        // Refined Heuristic: Detect quoted values while ignoring mandatory structural quotes
                        const hasQuotedProps = lines.some(line => {
                            // (?![\[{@#*&!%>|]) ensures the quote is NOT immediately followed by a YAML special character
                            
                            // Match root-level properties & inline arrays: key: "val" OR key: ["val"]
                            if (/^[^\s:]+:\s*\[?\s*["'](?![\[{@#*&!%>|])/.test(line)) return true;
                            // Match indented list items: - "val"
                            if (/^\s+-\s*["'](?![\[{@#*&!%>|])/.test(line)) return true;
                            return false;
                        });

                        if (hasQuotedProps) {
                            stats.quotedFrontmatterCount++;
                            stats.quotedFrontmatterFiles.push(file);
                        }

                        const hasTags = cache.frontmatter.tags !== undefined || cache.frontmatter.tag !== undefined;
                        if (hasTags) {
                            for (let i = 0; i < lines.length; i++) {
                                const line = lines[i];
                                const match = line.match(/^(tags?):(.*)$/i);
                                if (match) {
                                    const value = match[2].trim();
                                    if (value.startsWith('[')) {
                                        stats.formatStats.inlineArray.push(file);
                                    } else if (!value || value === '') {
                                        for (let j = i + 1; j < lines.length; j++) {
                                            const nextLine = lines[j].trim();
                                            if (!nextLine) continue; 
                                            if (nextLine.startsWith('-')) {
                                                stats.formatStats.yamlList.push(file);
                                            }
                                            break;
                                        }
                                    } else {
                                        stats.formatStats.mixed.push(file);
                                    }
                                    break;
                                }
                            }
                        }
                    }
                }
            } catch (e) { /* Ignore read errors */ }
        }

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
        const fmTagsSet = new Set<string>();
        const bodyTagsSet = new Set<string>();

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
                    fmTagsSet.add(clean);
                    if (clean.includes('/')) fileNestedSet.add(clean);
                });
            }

            // Body (Inline Tags)
            if (cache.tags) {
                cache.tags.forEach(t => {
                    const clean = t.tag.startsWith('#') ? t.tag.substring(1) : t.tag;
                    bodyTagsSet.add(clean);
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

        stats.locationStats.frontmatter = Array.from(fmTagsSet).sort();
        stats.locationStats.body = Array.from(bodyTagsSet).sort();

        // Calculate Average
        stats.lengthStats.avgLength = totalTags > 0 ? Math.round(totalLength / totalTags) : 0;

        // Calculate Consistencies
        const calcConsistency = (arrays: string[][]) => {
            if (totalTags === 0) return 100;
            const dominant = Math.max(...arrays.map(a => a.length));
            return Math.round((dominant / totalTags) * 100);
        };

        stats.caseStats.consistency = calcConsistency([stats.caseStats.lowercase, stats.caseStats.uppercase, stats.caseStats.mixed]);

        // For separators
        const sepArrays = [stats.separatorStats.underscore, stats.separatorStats.hyphen, stats.separatorStats.none];
        const dominantSep = Math.max(...sepArrays.map(a => a.length));
        const inconsistentSep = stats.separatorStats.both.length;
        stats.separatorStats.consistency = totalTags > 0 
            ? Math.min(100, Math.round((dominantSep / (totalTags - inconsistentSep || 1)) * 100))
            : 100;

        stats.specialCharStats.consistency = totalTags > 0 
            ? Math.round((stats.specialCharStats.clean.length / totalTags) * 100)
            : 100;

        return stats;
    }


    async findInvalidTagFormats(): Promise<InvalidTagFile[]> {
        const invalidFiles: InvalidTagFile[] = [];
        const files = this.getFilteredFiles();

        // Exact list of prohibited characters from USER_REQUEST
        const INVALID_CHARS = /[!@£$%^&*()=+[\]{}:;'",.<>?|\\]/;
        const PURE_NUMERIC = /^\d+$/;

        for (const file of files) {
            const issues: { description: string; tag?: string }[] = [];
            const cache = this.app.metadataCache.getFileCache(file);

            // 1, 2, 3: Common tag string validation helper
            const validateTagString = (t: string, context: string): { description: string; tag?: string } | null => {
                if (typeof t !== 'string') return null;
                const trimmed = t.trim();
                if (trimmed.length === 0) return null;

                if (t !== trimmed) return { description: `${context} "${t}" has extra spaces`, tag: t };
                if (trimmed.includes(' ')) return { description: `${context} "${t}" contains spaces`, tag: t };
                if (PURE_NUMERIC.test(trimmed)) return { description: `${context} "${t}" consists solely of numbers`, tag: t };
                if (INVALID_CHARS.test(trimmed)) return { description: `${context} "${t}" contains prohibited special characters`, tag: t };

                return null;
            };

            // 4. Incorrect Front Matter Syntax (only checking 'tags' and 'tag' keys)
            const fm = cache?.frontmatter;
            if (fm) {
                const seenInFM = new Set<string>();
                const checkFMKey = (key: string, value: any) => {
                    if (value === undefined || value === null) return;
                    if (typeof value === 'string') {
                        const clean = value.startsWith('#') ? value.substring(1) : value;
                        if (seenInFM.has(clean)) {
                            issues.push({ description: `Front matter contains duplicate tag: "${clean}"`, tag: value });
                        }
                        seenInFM.add(clean);

                        if (value.startsWith('#')) {
                            issues.push({ description: `Front matter "${key}" starts with # (invalid YAML syntax)`, tag: value });
                        }
                        const err = validateTagString(value, `Front matter ${key}`);
                        if (err) issues.push(err);
                    } else if (Array.isArray(value)) {
                        value.forEach(t => {
                            const tagStr = String(t);
                            const clean = tagStr.startsWith('#') ? tagStr.substring(1) : tagStr;
                            
                            if (seenInFM.has(clean)) {
                                issues.push({ description: `Front matter contains duplicate tag: "${clean}"`, tag: tagStr });
                            }
                            seenInFM.add(clean);

                            if (typeof t === 'string' && t.startsWith('#')) {
                                issues.push({ description: `Front matter list item "${t}" starts with #`, tag: tagStr });
                            }
                            const err = validateTagString(tagStr, `Front matter list item`);
                            if (err) issues.push(err);
                        });
                    }
                };

                if ('tags' in fm) checkFMKey('tags', fm.tags);
                if ('tag' in fm) checkFMKey('tag', fm.tag);
            }

            if (issues.length > 0) {
                // Deduplicate by description
                let uniqueIssues = Array.from(new Map(issues.map(i => [i.description, i])).values());
                
                // Filter out ignored issues
                uniqueIssues = uniqueIssues.filter(issue => {
                    const id = `${file.path}|${issue.description}`;
                    return !this.settings.ignoredIssues.includes(id);
                });

                if (uniqueIssues.length > 0) {
                    invalidFiles.push({
                        path: file.path,
                        file: file,
                        issues: uniqueIssues
                    });
                }
            }
        }

        return invalidFiles;
    }

    async convertTagFormat(files: TFile[], format: 'inline' | 'list') {
        const progressModal = new ProgressModal(this.app, files.length);
        progressModal.open();
        let count = 0;

        for (const file of files) {
            try {
                await this.app.vault.process(file, (content) => {
                    const fmMatch = content.match(/^---\n([\s\S]*?)\n---/);
                    if (!fmMatch) return content;

                    const fmContent = fmMatch[1];
                    const lines = fmContent.split('\n');
                    let keyIndex = -1;
                    let keyName = '';

                    // Find 'tags:' or 'tag:'
                    for (let i = 0; i < lines.length; i++) {
                        const m = lines[i].match(/^(tags?):/);
                        if (m) {
                            keyIndex = i;
                            keyName = m[1];
                            break;
                        }
                    }

                    if (keyIndex === -1) return content;

                    // Determine range of existing value
                    let endIndex = keyIndex;
                    for (let i = keyIndex + 1; i < lines.length; i++) {
                        // If line starts with non-whitespace, it's a new key
                        if (lines[i].match(/^\S/)) break;
                        endIndex = i;
                    }

                    // Get current tags value
                    const cache = this.app.metadataCache.getFileCache(file);
                    let tags = cache?.frontmatter?.[keyName];
                    if (!tags) return content; // Empty? 

                    if (typeof tags === 'string') tags = tags.split(',').map(t => t.trim());
                    if (!Array.isArray(tags)) tags = [tags];
                    tags = tags.filter((t: any) => t && typeof t === 'string' && t.trim().length > 0);

                    if (tags.length === 0) return content;

                    // Construct new lines
                    const newLines: string[] = [];
                    const safeTag = (t: string) => {
                        return t.match(/[:#[\]{}|>]/) ? `"${t.replace(/"/g, '\\"')}"` : t;
                    };

                    if (format === 'inline') {
                        const safeTagsStr = tags.map((t: string) => safeTag(t)).join(', ');
                        newLines.push(`${keyName}: [${safeTagsStr}]`);
                    } else {
                        newLines.push(`${keyName}:`);
                        tags.forEach((t: string) => newLines.push(`  - ${safeTag(t)}`));
                    }

                    // Splice
                    lines.splice(keyIndex, endIndex - keyIndex + 1, ...newLines);

                    // Issue 5: Secure reconstruction using match indices
                    const fmStart = content.indexOf('---\n');
                    const fmEnd = content.indexOf('\n---', fmStart + 4) + 4;
                    if (fmStart === -1 || fmEnd === -1) return content; // Fallback

                    return content.substring(0, fmStart + 4) + lines.join('\n') + content.substring(fmEnd - 4);
                });
                count++;
                progressModal.update(count);
            } catch (e) { console.error('Format conversion failed', e); }
        }
        progressModal.close();
        new Notice(`Converted tags to ${format === 'inline' ? 'Inline Array' : 'YAML List'} in ${count} files.`);
    }

    // Automated Standardization removed per user request: "THE PLUGIN SHOULD NOT FIX INVALID TAGS"

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


    // --- Aliases ---

    async applyAliases(file: TFile) {
        const aliases = this.settings.aliases;
        if (Object.keys(aliases).length === 0) return;

        let modified = false;

        await this.app.fileManager.processFrontMatter(file, (fm) => {
            const processSingleTag = (t: string): string => {
                if (typeof t !== 'string') return t;
                const hasHash = t.startsWith('#');
                const raw = hasHash ? t.substring(1) : t;
                if (aliases[raw]) {
                    modified = true;
                    return hasHash ? '#' + aliases[raw] : aliases[raw];
                }
                return t;
            };

            // Issue 8: Idempotency check
            if (fm.tags) {
                if (Array.isArray(fm.tags)) {
                    const newTags = fm.tags.map(processSingleTag);
                    if (newTags.some((t, i) => t !== fm.tags[i])) fm.tags = newTags;
                } else if (typeof fm.tags === 'string') {
                    const newTag = processSingleTag(fm.tags);
                    if (newTag !== fm.tags) fm.tags = newTag;
                }
            }
            if (fm.tag) {
                if (Array.isArray(fm.tag)) {
                    const newTags = fm.tag.map(processSingleTag);
                    if (newTags.some((t, i) => t !== fm.tag[i])) fm.tag = newTags;
                } else if (typeof fm.tag === 'string') {
                    const newTag = processSingleTag(fm.tag);
                    if (newTag !== fm.tag) fm.tag = newTag;
                }
            }
        });

        await this.app.vault.process(file, (data) => {
            const codeBlockRanges = this.getCodeBlockRanges(data);
            let result = data;
            for (const [alias, canonical] of Object.entries(aliases)) {
                const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
                const regex = new RegExp(`(^|\\s)(#)(${escapeRegExp(alias)})(?=[\\s\\/]|$|[^\\p{L}\\p{N}_-])`, 'gu');
                
                result = result.replace(regex, (m, prefix, hash, captured, offset) => {
                    if (this.isInCodeBlockRange(offset, codeBlockRanges)) return m;
                    
                    if (canonical !== alias) modified = true;
                    return prefix + hash + canonical;
                });
            }
            return result;
        });

        // Auto-aliases are not recorded in history to avoid churn and pushing out bulk operations
    }

    // --- Core Processing ---

    // Issue 1: Accept overrides instead of mutating settings
    async processFile(file: TFile, overrides?: { caseStrategy?: 'lowercase' | 'uppercase' | 'none' }): Promise<string> {
        let finalContent = '';
        await this.app.fileManager.processFrontMatter(file, (fm) => {
            const processSingleTag = (t: string): string => {
                if (typeof t !== 'string') return t;
                const hasHash = t.startsWith('#');
                const clean = hasHash ? t.substring(1) : t;
                const converted = this.convertTagContent(clean, overrides);
                return hasHash ? '#' + converted : converted;
            };

            // Issue 8: Only assign back if something actually changed
            if (fm.tags) {
                if (Array.isArray(fm.tags)) {
                    const newTags = fm.tags.map(processSingleTag);
                    if (newTags.some((t, i) => t !== fm.tags[i])) {
                        fm.tags = newTags;
                    }
                } else if (typeof fm.tags === 'string') {
                    const newTag = processSingleTag(fm.tags);
                    if (newTag !== fm.tags) fm.tags = newTag;
                }
            }
            if (fm.tag) {
                if (Array.isArray(fm.tag)) {
                    const newTags = fm.tag.map(processSingleTag);
                    if (newTags.some((t, i) => t !== fm.tag[i])) {
                        fm.tag = newTags;
                    }
                } else if (typeof fm.tag === 'string') {
                    const newTag = processSingleTag(fm.tag);
                    if (newTag !== fm.tag) fm.tag = newTag;
                }
            }
        });

        await this.app.vault.process(file, (data) => {
            finalContent = this.transformContent(data, overrides);
            return finalContent;
        });
        
        return finalContent;
    }

    convertTagContent(tagContent: string, overrides?: { caseStrategy?: 'lowercase' | 'uppercase' | 'none' }): string {
        const parts = tagContent.split('/');
        const processedParts = parts.map((part, index) => {
            if (index > 0 && !this.settings.applyToNestedTags) return part;
            return this.transformSegment(part, overrides);
        });
        return processedParts.join('/');
    }

    transformSegment(segment: string, overrides?: { caseStrategy?: 'lowercase' | 'uppercase' | 'none' }): string {
        let s = segment;
        if (this.settings.removeSpecialChars) {
            s = s.replace(/[^\p{L}\p{N}\-_]/gu, '');
        }
        if (this.settings.flattenDiacritics) {
            s = s.normalize("NFD").replace(/\p{Diacritic}/gu, "");
        }
        if (this.settings.separatorStrategy === 'snake') {
            s = s.replace(/-/g, '_');
        } else if (this.settings.separatorStrategy === 'kebab') {
            s = s.replace(/_/g, '-');
        }

        const caseStrategy = overrides?.caseStrategy || this.settings.caseStrategy;
        if (caseStrategy === 'lowercase') {
            s = s.toLowerCase();
        } else if (caseStrategy === 'uppercase') {
            s = s.toUpperCase();
        }
        return s;
    }

    private transformContent(content: string, overrides?: { caseStrategy?: 'lowercase' | 'uppercase' | 'none' }): string {
        // Skip code blocks
        const codeBlockRegex = /```[\s\S]*?```|`[^`\n]+`/g;
        const codeBlocks: { start: number; end: number }[] = [];
        let match;

        // Issue 11: Skip frontmatter in transformContent to avoid double transformation
        const fmMatch = content.match(/^---\n[\s\S]*?\n---/);
        const skipStart = fmMatch ? fmMatch[0].length : 0;

        while ((match = codeBlockRegex.exec(content)) !== null) {
            codeBlocks.push({ start: match.index, end: match.index + match[0].length });
        }

        return content.replace(TAG_REGEX, (fullMatch, prefix, tag, offset) => {
            // Check if inside frontmatter
            if (offset < skipStart) return fullMatch;

            // Check if inside code block
            if (codeBlocks.some(b => offset >= b.start && offset < b.end)) {
                return fullMatch;
            }

            const clean = tag.substring(1);
            const converted = this.convertTagContent(clean, overrides);
            return prefix + '#' + converted;
        });
    }


    async convertAllToCase(targetCase: 'uppercase' | 'lowercase') {
        const files = this.getFilteredFiles();
        const changes: FileChange[] = [];
        let processedCount = 0;

        const progressModal = new ProgressModal(this.app, files.length);
        progressModal.open();

        for (const file of files) {
            try {
                const before = await this.app.vault.read(file);
                
                // Issue 1: Use overrides instead of mutating shared state
                const after = await this.processFile(file, { caseStrategy: targetCase });

                if (before !== after) {
                    changes.push({ path: file.path, before, after });
                }
                processedCount++;
                progressModal.update(processedCount);
            } catch (e) {
                console.error(`Failed to convert case in ${file.path}`, e);
                processedCount++;
                progressModal.update(processedCount);
            }
        }
        progressModal.close();

        if (changes.length > 0) {
            await this.addToHistory({
                type: 'convert',
                description: `Bulk convert to ${targetCase} (${changes.length} files)`,
                changes
            });
        }
        new Notice(`Converted tags to ${targetCase} in ${changes.length} files.`);
    }

    getAllTags(): string[] {
        const tags = (this.app.metadataCache as any).getTags() || {};
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
        
        const warning = contentEl.createEl('p', { cls: 'btm-preview-warning' });
        warning.setText('Note: Detailed line diffs for frontmatter tags are not shown, but they will be standardized.');
        warning.style.color = 'var(--text-warning)';
        warning.style.fontSize = 'var(--font-ui-smaller)';

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
        
        if (this.plugin.settings.historyExpirationDays > 0) {
            contentEl.createEl('p', { 
                text: `History is automatically cleared every ${this.plugin.settings.historyExpirationDays} days.`,
                cls: 'btm-history-clarification'
            }).style.color = 'var(--text-muted)';
        }

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
            
            // If paths are cleared from data.json, we need to handle count display
            // We can't easily know the count without reading the manifest, so we check if it's external
            if (op.useExternalManifest) {
                itemEl.createDiv({ cls: 'btm-history-files', text: `Operation recorded externally` });
            } else {
                itemEl.createDiv({ cls: 'btm-history-files', text: `${op.changes.length} files affected` });
            }

            if (op === this.plugin.settings.operationHistory[0]) {
                if ((op as any).nonRevertible) {
                    itemEl.createDiv({ 
                        cls: 'btm-history-warning', 
                        text: '⚠ Snapshots omitted due to size - cannot undo.' 
                    }).style.color = 'var(--text-warning)';
                } else {
                    const revertBtn = itemEl.createEl('button', { text: 'Undo', cls: 'btm-revert-btn' });
                    revertBtn.onclick = async () => {
                        this.close();
                        await this.plugin.undoLastOperation();
                    };
                }
            }
        }
    }

    onClose() {
        this.contentEl.empty();
    }
}

// Themed Confirmation Modal
class BtmConfirmationModal extends Modal {
    private message: string;
    private onConfirm: () => void;
    private title: string;

    constructor(app: App, title: string, message: string, onConfirm: () => void) {
        super(app);
        this.title = title;
        this.message = message;
        this.onConfirm = onConfirm;
    }

    onOpen() {
        const { contentEl } = this;
        contentEl.empty();
        this.modalEl.addClass('btm-confirmation-modal-window');
        contentEl.addClass('btm-confirmation-modal');

        // Premium centered title
        contentEl.createEl('h2', { text: this.title, cls: 'btm-conf-title' });
        
        contentEl.createEl('p', { text: this.message, cls: 'btm-conf-message' });

        const btnRow = contentEl.createDiv({ cls: 'btm-button-row-centered' });
        
        const cancelBtn = btnRow.createEl('button', { text: 'Cancel', cls: 'btm-conf-btn' });
        cancelBtn.onclick = () => this.close();

        const confirmBtn = btnRow.createEl('button', { text: 'Confirm', cls: 'mod-cta btm-conf-btn' });
        confirmBtn.onclick = () => {
            this.close();
            this.onConfirm();
        };
    }

    onClose() {
        this.contentEl.empty();
    }
}

// Tag Hierarchy Modal
class TagHierarchyModal extends Modal {
    private plugin: TagLowercasePlugin;
    private searchQuery: string = '';
    private sortStrategy: 'alphabetical' | 'nesting' | 'usage' = 'alphabetical';
    private treeEl: HTMLElement;
    private hierarchy: TagNode[];

    constructor(app: App, plugin: TagLowercasePlugin) {
        super(app);
        this.plugin = plugin;
    }

    onOpen() {
        const { contentEl } = this;
        contentEl.empty();
        contentEl.addClass('btm-hierarchy-modal');

        new Setting(contentEl)
            .setName('Nested Tags')
            .setHeading();

        this.hierarchy = this.plugin.getTagHierarchy().filter(n => n.children.length > 0);

        if (this.hierarchy.length === 0) {
            contentEl.createEl('p', { text: 'No nested tags found in vault.' });
            return;
        }

        // Row 1: Search (Full Width)
        const searchRow = contentEl.createDiv({ cls: 'btm-tree-search-row' });
        const searchInput = new TextComponent(searchRow)
            .setPlaceholder('Search tags...')
            .onChange((value) => {
                this.searchQuery = value;
                this.updateDisplay();
            });
        searchInput.inputEl.addClass('btm-tree-search-input');

        // Row 2: Sort and Action Buttons
        const controlRow = contentEl.createDiv({ cls: 'btm-tree-controls-row' });
        
        const sortLabel = controlRow.createSpan({ text: 'Sort by:', cls: 'btm-control-label' });
        const dropdown = new DropdownComponent(controlRow)
            .addOption('alphabetical', 'A-Z')
            .addOption('nesting', 'Nested Count')
            .addOption('usage', 'Usage')
            .setValue(this.sortStrategy)
            .onChange((value: any) => {
                this.sortStrategy = value;
                this.updateDisplay();
            });
        dropdown.selectEl.addClass('btm-tree-sort-dropdown');

        const spacer = controlRow.createDiv({ cls: 'btm-spacer' });

        const expandBtn = controlRow.createEl('button', { text: 'Expand All', cls: 'btm-tiny-btn' });
        const collapseBtn = controlRow.createEl('button', { text: 'Collapse All', cls: 'btm-tiny-btn' });

        // Tree Area
        this.treeEl = contentEl.createDiv({ cls: 'btm-tree-container' });
        this.updateDisplay();

        expandBtn.onclick = () => {
            this.treeEl.querySelectorAll('.btm-tree-children').forEach(el => el.removeClass('is-collapsed'));
            this.treeEl.querySelectorAll('.btm-tree-collapse-icon').forEach(el => {
                setIcon(el as HTMLElement, 'chevron-down');
            });
        };

        collapseBtn.onclick = () => {
            this.treeEl.querySelectorAll('.btm-tree-children').forEach(el => el.addClass('is-collapsed'));
            this.treeEl.querySelectorAll('.btm-tree-collapse-icon').forEach(el => {
                setIcon(el as HTMLElement, 'chevron-right');
            });
        };
    }

    private deepCloneNodes(nodes: TagNode[]): TagNode[] {
        return nodes.map(node => ({
            ...node,
            children: this.deepCloneNodes(node.children)
        }));
    }

    private updateDisplay() {
        this.treeEl.empty();
        // Use deep clone to avoid mutation side effects
        const clonedHierarchy = this.deepCloneNodes(this.hierarchy);
        let filtered = this.filterNodes(clonedHierarchy, this.searchQuery);
        this.sortNodes(filtered);
        this.renderTree(this.treeEl, filtered, 0);
    }

    private filterNodes(nodes: TagNode[], query: string): TagNode[] {
        if (!query) return nodes.map(n => ({ ...n }));

        const q = query.toLowerCase();
        return nodes.map(node => {
            const matchesSelf = node.name.toLowerCase().includes(q);
            // Fix: If parent matches, keep all children for context
            const filteredChildren = matchesSelf ? node.children : this.filterNodes(node.children, query);
            
            if (matchesSelf || filteredChildren.length > 0) {
                return { ...node, children: filteredChildren };
            }
            return null;
        }).filter(n => n !== null) as TagNode[];
    }

    private sortNodes(nodes: TagNode[]) {
        nodes.sort((a, b) => {
            if (this.sortStrategy === 'nesting') {
                return b.children.length - a.children.length || a.name.localeCompare(b.name);
            } else if (this.sortStrategy === 'usage') {
                return b.count - a.count || a.name.localeCompare(b.name);
            } else {
                return a.name.localeCompare(b.name);
            }
        });
        
        for (const node of nodes) {
            if (node.children.length > 0) {
                this.sortNodes(node.children);
            }
        }
    }

    private renderTree(container: HTMLElement, nodes: TagNode[], depth: number) {
        for (const node of nodes) {
            const hasChildren = node.children.length > 0;
            const nodeEl = container.createDiv({ cls: 'btm-tree-node' });
            
            const headerEl = nodeEl.createDiv({ cls: 'btm-tree-header' });
            
            const collapseIcon = headerEl.createSpan({ cls: 'btm-tree-collapse-icon' });
            if (hasChildren) {
                setIcon(collapseIcon, 'chevron-down');
            }

            const iconEl = headerEl.createSpan({ cls: 'btm-tree-icon' });
            setIcon(iconEl, hasChildren ? 'folder' : 'tag');
            
            headerEl.createSpan({ text: node.name, cls: 'btm-tree-name' });
            if (node.count > 0) {
                headerEl.createSpan({ text: ` (${node.count})`, cls: 'btm-tree-count' });
            }

            if (hasChildren) {
                const childContainer = nodeEl.createDiv({ cls: 'btm-tree-children' });
                this.renderTree(childContainer, node.children, depth + 1);

                collapseIcon.onclick = (e) => {
                    e.stopPropagation();
                    const isCollapsed = childContainer.hasClass('is-collapsed');
                    if (isCollapsed) {
                        childContainer.removeClass('is-collapsed');
                        setIcon(collapseIcon, 'chevron-down');
                    } else {
                        childContainer.addClass('is-collapsed');
                        setIcon(collapseIcon, 'chevron-right');
                    }
                };

                headerEl.onclick = () => {
                    const isCollapsed = childContainer.hasClass('is-collapsed');
                    if (isCollapsed) {
                        childContainer.removeClass('is-collapsed');
                        setIcon(collapseIcon, 'chevron-down');
                    } else {
                        childContainer.addClass('is-collapsed');
                        setIcon(collapseIcon, 'chevron-right');
                    }
                };
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

            const issuesEl = itemEl.createDiv({ cls: 'btm-invalid-issues' });
            for (const issue of item.issues) {
                const issueEl = issuesEl.createDiv({ cls: 'btm-invalid-issue-manual' });
                
                const infoEl = issueEl.createDiv({ cls: 'btm-issue-info' });
                setIcon(infoEl.createSpan({ cls: 'btm-icon' }), 'alert-circle');
                infoEl.createSpan({ text: ' ' + issue.description });

                const actionRow = issueEl.createDiv({ cls: 'btm-fix-manual-row' });
                
                const desc = issue.description.toLowerCase();
                const isDuplicate = desc.includes('duplicate');
                const isExtraSpace = desc.includes('extra space');
                
                if (isDuplicate || isExtraSpace) {
                    const removeBtn = actionRow.createEl('button', { text: 'Remove', cls: 'btm-small-btn mod-warning' });
                    removeBtn.onclick = async () => {
                        const file = this.app.vault.getAbstractFileByPath(item.path);
                        if (file instanceof TFile && issue.tag) {
                            await this.app.fileManager.processFrontMatter(file, (fm) => {
                                const removeOne = (key: string) => {
                                    if (fm[key]) {
                                        if (typeof fm[key] === 'string' && fm[key] === issue.tag) {
                                            delete fm[key];
                                        } else if (Array.isArray(fm[key])) {
                                            if (isDuplicate) {
                                                const idx = fm[key].indexOf(issue.tag);
                                                if (idx > -1) fm[key].splice(idx, 1);
                                            } else if (isExtraSpace) {
                                                fm[key] = fm[key].map((t: any) => (String(t) === issue.tag ? String(t).trim() : t));
                                            }
                                        }
                                    }
                                };
                                removeOne('tags');
                                removeOne('tag');
                            });
                            issueEl.remove();
                            this.checkEmpty(itemEl, issuesEl, listEl);
                            new Notice('Applied automated fix.');
                        }
                    };
                } else {
                    const goBtn = actionRow.createEl('button', { text: 'Go to note', cls: 'btm-small-btn' });
                    goBtn.onclick = () => {
                        this.close();
                        this.app.workspace.openLinkText(item.path, '', false);
                    };
                }

                const ignoreBtn = actionRow.createEl('button', { text: 'Ignore', cls: 'btm-small-btn' });
                ignoreBtn.onclick = async () => {
                    const id = `${item.path}|${issue.description}`;
                    this.plugin.settings.ignoredIssues.push(id);
                    await this.plugin.saveSettings();
                    issueEl.remove();
                    this.checkEmpty(itemEl, issuesEl, listEl);
                    new Notice('Issue ignored.');
                };
            }
        }

        const btnRow = contentEl.createDiv({ cls: 'btm-button-row' });
        const closeBtn = btnRow.createEl('button', { text: 'Close' });
        closeBtn.onclick = () => this.close();
    }

    private checkEmpty(itemEl: HTMLElement, issuesEl: HTMLElement, listEl: HTMLElement) {
        if (issuesEl.children.length === 0) itemEl.remove();
        if (listEl.children.length === 0) {
            this.close();
            new Notice('All issues resolved.');
        }
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

            const tagText = tag.startsWith('#') ? tag : '#' + tag;
            itemEl.createSpan({ text: tagText, cls: 'btm-tag-pill' });

            const btn = itemEl.createEl('button', { text: 'Search', cls: 'btm-search-btn' });
            btn.onclick = () => {
                this.close();
                const searchPlugin = (this.app as any).internalPlugins?.getPluginById('global-search');
                if (searchPlugin?.instance) {
                    searchPlugin.instance.openGlobalSearch(`tag:${tagText}`);
                } else {
                    new Notice('Global Search plugin not enabled');
                }
            };
        }

        const btnRow = contentEl.createDiv({ cls: 'btm-button-row' });
        btnRow.createEl('button', { text: 'Close' }).onclick = () => this.close();
    }

    onClose() {
        this.contentEl.empty();
    }
}

class SimpleFileListModal extends Modal {
    private files: TFile[];
    private title: string;

    constructor(app: App, title: string, files: TFile[]) {
        super(app);
        this.title = title;
        this.files = files;
    }

    onOpen() {
        const { contentEl } = this;
        contentEl.empty();
        contentEl.addClass('btm-file-list-modal');

        new Setting(contentEl)
            .setName(this.title)
            .setDesc(`${this.files.length} files found`)
            .setHeading();

        const listEl = contentEl.createDiv({ cls: 'btm-file-list' });

        for (const file of this.files) {
            const itemEl = listEl.createDiv({ cls: 'btm-file-item' });
            itemEl.createEl('a', { text: file.path, cls: 'btm-file-link' })
                .onclick = () => {
                    this.close();
                    this.app.workspace.openLinkText(file.path, '', false);
                };
        }

        const btnRow = contentEl.createDiv({ cls: 'btm-button-row' });
        btnRow.createEl('button', { text: 'Close' }).onclick = () => this.close();
    }

    onClose() {
        this.contentEl.empty();
    }
}

class BtmErrorReportModal extends Modal {
    private plugin: TagLowercasePlugin;
    private errors: { path: string; message: string }[];
    private title: string;

    constructor(app: App, plugin: TagLowercasePlugin, title: string, errors: { path: string; message: string }[]) {
        super(app);
        this.plugin = plugin;
        this.title = title;
        this.errors = errors;
    }

    onOpen() {
        const { contentEl } = this;
        contentEl.empty();
        contentEl.addClass('btm-file-list-modal');
        
        // Ensure modal is large enough and styled
        this.modalEl.style.width = '80vw';
        this.modalEl.style.maxWidth = '800px';

        new Setting(contentEl)
            .setName(this.title)
            .setDesc(`${this.errors.length} issues found. Click a path to open the note.`)
            .setHeading();

        const listEl = contentEl.createDiv({ cls: 'btm-file-list' });
        listEl.style.maxHeight = '60vh';
        listEl.style.overflowY = 'auto';
        listEl.style.marginTop = '20px';

        if (this.errors.length === 0) {
            listEl.createEl('p', { text: 'No errors to display.', cls: 'btm-loading' });
        } else {
            for (const err of this.errors) {
                const itemEl = listEl.createDiv({ cls: 'btm-file-item' });
                itemEl.style.borderLeft = '4px solid var(--text-error)';
                itemEl.style.padding = '10px';
                itemEl.style.marginBottom = '10px';
                itemEl.style.background = 'var(--background-secondary-alt)';
                itemEl.style.borderRadius = '4px';

                const pathLink = itemEl.createEl('a', { text: err.path, cls: 'btm-file-link' });
                pathLink.style.display = 'block';
                pathLink.style.fontWeight = 'bold';
                pathLink.style.marginBottom = '5px';
                pathLink.onclick = () => {
                    this.close();
                    this.app.workspace.openLinkText(err.path, '', false);
                };

                itemEl.createDiv({ text: `Error: ${err.message}` }).style.color = 'var(--text-error)';
                itemEl.style.fontSize = 'var(--font-ui-small)';

                // Add Fix button if it's a mapping error
                const msg = err.message.toLowerCase();
                if (msg.includes('mapping') || msg.includes('colon') || msg.includes('syntax')) {
                    const actionRow = itemEl.createDiv({ cls: 'btm-button-row' });
                    actionRow.style.justifyContent = 'flex-start';
                    actionRow.style.marginTop = '10px';

                    const fixBtn = actionRow.createEl('button', { text: 'Fix Syntax', cls: 'mod-cta' });
                    fixBtn.style.padding = '2px 10px';
                    fixBtn.style.fontSize = '11px';
                    
                    fixBtn.onclick = async () => {
                        const file = this.app.vault.getAbstractFileByPath(err.path);
                        if (file instanceof TFile) {
                            await this.plugin.fixInvalidMappingError(file);
                            itemEl.style.opacity = '0.5';
                            fixBtn.disabled = true;
                            fixBtn.setText('Fixed');
                            new Notice(`Fixed YAML syntax in: ${file.basename}`);
                        }
                    };
                }
            }
        }

        const btnRow = contentEl.createDiv({ cls: 'btm-button-row' });
        btnRow.createEl('button', { text: 'Close' }).onclick = () => this.close();
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
        this.tagCounts = (this.plugin.app.metadataCache as any).getTags() || {};
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
        this.tagCounts = (this.plugin.app.metadataCache as any).getTags() || {};
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

        const allFolders = this.getAllFolders();
        let displayFolders: string[] = [];

        if (!query) {
            // Show selected folders first when no query
            displayFolders = Array.from(this.selectedFolders).sort();
            if (displayFolders.length === 0) {
                this.listEl.createEl('p', { text: 'Start typing to search folders...', cls: 'btm-loading' });
                return;
            }
            this.listEl.createEl('div', { text: 'Selected Folders:', cls: 'btm-list-header' });
        } else {
            displayFolders = allFolders.filter(f => f.toLowerCase().includes(query)).slice(0, 100);
            if (displayFolders.length === 0) {
                this.listEl.createEl('p', { text: 'No folders found', cls: 'btm-no-results' });
                return;
            }
        }

        for (const folder of displayFolders) {
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
    deleteInput: TextComponent;
    patternInput: TextComponent;
    patternReplaceInput: TextComponent;
    metricsGrid: HTMLElement; // For layout consistency
    invalidBlock: HTMLElement;
    invalidContentEl: HTMLElement;

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
        
        // Fix One: Invalid Tags Block (Directly below Overview)
        this.invalidBlock = contentEl.createDiv({ cls: 'btm-section-box btm-invalid-block' });
        this.invalidBlock.createDiv({ cls: 'btm-collapsible-header' }).createSpan({ text: 'Invalid Tags (Real-time)' });
        this.invalidContentEl = this.invalidBlock.createDiv({ cls: 'btm-invalid-content' });

        this.updateStats().catch(e => console.error("Failed to update stats", e));

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
        const tagCountDisplay = findCol.createDiv({ cls: 'btm-tag-count-display', attr: { style: 'margin-top: 4px; color: var(--text-muted); font-size: var(--font-ui-smaller);' } });

        findSuggestBtn.onclick = () => new TagSuggest(this.app, this.plugin, (t) => {
            this.findInput.setValue(t);
            const tags = (this.plugin.app.metadataCache as any).getTags() || {};
            const count = tags['#' + t] || 0;
            tagCountDisplay.textContent = `${count} pos`;
        }).open();

        // Col 2: Replace
        const replaceCol = renameContainer.createDiv({ cls: 'btm-field-column' });
        replaceCol.createEl('label', { text: 'Replace' });
        this.replaceInput = new TextComponent(replaceCol).setPlaceholder('#new-tag');

        // Col 3: Action
        const actionCol = renameContainer.createDiv({ cls: 'btm-field-column' });
        const btnRename = actionCol.createEl('button', { text: 'Rename', cls: 'mod-cta btm-action-btn' });
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
        const mergeActionCol = mergeContainer.createDiv({ cls: 'btm-field-column' });
        const btnMerge = mergeActionCol.createEl('button', { text: 'Merge', cls: 'mod-cta btm-action-btn' });
        btnMerge.onclick = async () => {
            const sources = this.mergeSourcesInput.getValue().split(',').map(s => s.trim()).filter(s => s);
            const target = this.mergeTargetInput.getValue().trim();
            if (sources.length > 0 && target) {
                new BtmConfirmationModal(
                    this.app,
                    'Merge Tags',
                    `Are you sure you want to merge ${sources.length} source tags into "${target}"? This will modify multiple files.`,
                    async () => {
                        this.close();
                        await this.plugin.mergeTags(sources, target);
                    }
                ).open();
            } else {
                new Notice('Please provide source tags and a target.');
            }
        };

        // --- Delete Tags Section ---
        const deleteBox = contentEl.createDiv({ cls: 'btm-section-box' });
        deleteBox.createDiv({ cls: 'btm-collapsible-header' }).createSpan({ text: 'Delete Tags' });

        const deleteContainer = deleteBox.createDiv({ cls: 'btm-aligned-row' });

        // Col 1: Tags (Wide)
        const deleteCol = deleteContainer.createDiv({ cls: 'btm-field-column' });
        deleteCol.setAttr('style', 'grid-column: span 2;');

        deleteCol.createEl('label', { text: 'Tags to Delete (comma separated)' });
        this.deleteInput = new TextComponent(deleteCol).setPlaceholder('#bad-tag, #unused');
        this.deleteInput.inputEl.addClass('btm-full-width-input');
        // We handle width in CSS or rely on flex, but for now remove inline style if possible, or keep 100% if needed for layout.
        this.deleteInput.inputEl.style.width = '100%';

        const delBtnRow = deleteCol.createDiv({ attr: { style: 'display: flex; gap: 8px;' } });
        const delSelectBtn = delBtnRow.createEl('button', { cls: 'btm-suggest-btn btm-icon-btn btm-small-center-btn' });
        setIcon(delSelectBtn, 'list-filter');
        delSelectBtn.createSpan({ text: ' Select' });
        delSelectBtn.onclick = () => new MultiTagSelectModal(this.app, this.plugin, (tags) => {
            this.deleteInput.setValue(tags.map(t => '#' + t).join(', '));
        }).open();

        const delSearchBtn = delBtnRow.createEl('button', { cls: 'btm-suggest-btn btm-icon-btn btm-small-center-btn' });
        setIcon(delSearchBtn, 'search');
        delSearchBtn.createSpan({ text: ' Search' });
        delSearchBtn.onclick = () => new TagSuggest(this.app, this.plugin, (t) => {
            const current = this.deleteInput.getValue();
            this.deleteInput.setValue(current ? current + ', #' + t : '#' + t);
        }).open();

        // Col 3: Action
        const btnDelete = deleteContainer.createEl('button', { text: 'Delete', cls: 'mod-warning btm-action-btn' });
        btnDelete.onclick = async () => {
            const tags = this.deleteInput.getValue().split(',').map(s => s.trim()).filter(s => s);
            if (tags.length > 0) {
                new BtmConfirmationModal(
                    this.app,
                    'Delete Tags',
                    `Are you sure you want to delete ${tags.length} tags across your vault? This action cannot be undone easily.`,
                    async () => {
                        this.close();
                        await this.plugin.deleteTags(tags);
                    }
                ).open();
            } else {
                new Notice('Please provide tags to delete.');
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
                new BtmConfirmationModal(
                    this.app,
                    'Batch Rename (Pattern)',
                    `Are you sure you want to perform a batch rename using the pattern "${pattern}"? This will modify many files.`,
                    async () => {
                        this.close();
                        await this.plugin.batchRename(pattern, replacement);
                    }
                ).open();
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
                    this.updateStats().catch(e => console.error("Failed to update stats", e));
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
                    this.updateStats().catch(e => console.error("Failed to update stats", e));
                }));

        new Setting(settingsBox)
            .setName('Remove Special Characters')
            .setDesc('Removes everything except letters, numbers, hyphens (-), and underscores (_).')
            .addToggle(toggle => toggle
                .setValue(this.plugin.settings.removeSpecialChars)
                .onChange(async (value) => {
                    this.plugin.settings.removeSpecialChars = value;
                    await this.plugin.saveSettings();
                    this.updateStats().catch(e => console.error("Failed to update stats", e));
                }));

        new Setting(settingsBox)
            .setName('Flatten Diacritics')
            .setDesc('Converts accented characters to their plain equivalents (e.g., á → a, å → a).')
            .addToggle(toggle => toggle
                .setValue(this.plugin.settings.flattenDiacritics)
                .onChange(async (value) => {
                    this.plugin.settings.flattenDiacritics = value;
                    await this.plugin.saveSettings();
                    this.updateStats().catch(e => console.error("Failed to update stats", e));
                }));

        new Setting(settingsBox)
            .setName('Apply to Nested Tags')
            .addToggle(toggle => toggle
                .setValue(this.plugin.settings.applyToNestedTags)
                .onChange(async (value) => {
                    this.plugin.settings.applyToNestedTags = value;
                    await this.plugin.saveSettings();
                    this.updateStats().catch(e => console.error("Failed to update stats", e));
                }));

        // --- Scope Filter (Moved inside Bulk Settings) ---
        new Setting(settingsBox).setName('Scope Filter').setHeading();
        new Setting(settingsBox)
            .setName('Enable Scope Filter')
            .setDesc('Limit operations to specific folders')
            .addToggle(toggle => toggle
                .setValue(this.plugin.settings.scopeFilter.enabled)
                .onChange(async (value) => {
                    this.plugin.settings.scopeFilter.enabled = value;
                    await this.plugin.saveSettings();
                    this.updateStats().catch(e => console.error("Failed to update stats", e));
                }));

        const scopeContainer = settingsBox.createDiv({ cls: 'btm-scope-container' });

        // Include
        const includeCol = scopeContainer.createDiv({ cls: 'btm-field-column' });
        includeCol.createEl('label', { text: 'Include Folders' });
        const includeRow = includeCol.createDiv({ cls: 'btm-scope-input-row' });
        const includeDisplay = includeRow.createDiv({ text: this.plugin.settings.scopeFilter.includeFolders.join(', ') || '(all)', cls: 'btm-folder-input-display' });
        const includeBtn = includeRow.createEl('button', { cls: 'btm-suggest-btn btm-icon-btn btm-small-center-btn' });
        setIcon(includeBtn, 'folder-plus');
        includeBtn.onclick = () => new FolderSelectModal(this.app, this.plugin, this.plugin.settings.scopeFilter.includeFolders, async (f) => {
            this.plugin.settings.scopeFilter.includeFolders = f;
            await this.plugin.saveSettings();
            includeDisplay.textContent = f.join(', ') || '(all)';
            this.updateStats().catch(e => console.error("Failed to update stats", e));
        }).open();

        // Exclude
        const excludeCol = scopeContainer.createDiv({ cls: 'btm-field-column' });
        excludeCol.createEl('label', { text: 'Exclude Folders' });
        const excludeRow = excludeCol.createDiv({ cls: 'btm-scope-input-row' });
        const excludeDisplay = excludeRow.createDiv({ text: this.plugin.settings.scopeFilter.excludeFolders.join(', ') || '(none)', cls: 'btm-folder-input-display' });
        const excludeBtn = excludeRow.createEl('button', { cls: 'btm-suggest-btn btm-icon-btn btm-small-center-btn' });
        setIcon(excludeBtn, 'folder-minus');
        excludeBtn.onclick = () => new FolderSelectModal(this.app, this.plugin, this.plugin.settings.scopeFilter.excludeFolders, async (f) => {
            this.plugin.settings.scopeFilter.excludeFolders = f;
            await this.plugin.saveSettings();
            excludeDisplay.textContent = f.join(', ') || '(none)';
            this.updateStats().catch(e => console.error("Failed to update stats", e));
        }).open();

        // Relocated Buttons
        const bulkActionRow = settingsBox.createDiv({ cls: 'btm-action-row' });
        const btnConvertBulk = this.createIconButton(bulkActionRow, 'refresh-cw', 'Convert All', 'mod-cta');
        btnConvertBulk.onclick = async () => { this.close(); await this.plugin.runConversionWithPreview(); };

        // Removed Fix Invalid from here (it belongs in the Invalid Tags block below Overview)



        // --- Metadata Utilities ---
        const utilBox = contentEl.createDiv({ cls: 'btm-section-box' });
        utilBox.createDiv({ cls: 'btm-collapsible-header' }).createSpan({ text: 'Metadata Utilities' });
        const utilRow = utilBox.createDiv({ cls: 'btm-action-row' });
        
        const btnStandardize = this.createIconButton(utilRow, 'file-check', 'Standardise Properties');
        setTooltip(btnStandardize, 'Remove unnecessary quotes and trim whitespace from all frontmatter fields');
        btnStandardize.onclick = () => this.plugin.standardiseProperties();

        // --- Action Row (Bottom) ---
        const actionBox = contentEl.createDiv({ cls: 'btm-section-box' });
        actionBox.createDiv({ cls: 'btm-collapsible-header' }).createSpan({ text: 'Other actions' });
        const actionRow = actionBox.createDiv({ cls: 'btm-action-row' });

        // Convert All moved to Bulk Settings

        const btnList = this.createIconButton(actionRow, 'list', 'Tag List');
        setTooltip(btnList, 'View all tags in a list');
        btnList.onclick = async () => { this.close(); await this.plugin.generateTagList(); };

        const btnHierarchy = this.createIconButton(actionRow, 'git-branch', 'Tag Nesting');
        setTooltip(btnHierarchy, 'View tag hierarchy tree');
        btnHierarchy.onclick = () => { this.close(); new TagHierarchyModal(this.app, this.plugin).open(); };

        const btnOrphans = this.createIconButton(actionRow, 'alert-circle', 'Orphans');
        setTooltip(btnOrphans, 'Find orphaned tags');
        btnOrphans.onclick = () => { this.close(); new OrphanTagsModal(this.app, this.plugin).open(); };

        const btnHistory = this.createIconButton(actionRow, 'history', 'History');
        setTooltip(btnHistory, 'View and revert recent changes');
        btnHistory.onclick = () => { this.close(); new HistoryModal(this.app, this.plugin).open(); };
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

    async updateStats() {
        const files = this.plugin.getFilteredFiles();

        // Show loading if it's the first load
        if (this.statsEl.childElementCount === 0) {
            this.statsEl.createDiv({ text: 'Loading stats...', cls: 'btm-loading' });
        }

        // Pass files to analyzer (async)
        // Calculate BEFORE clearing to prevent flicker
        const stats = await this.plugin.analyzeTagStandardization(files);

        this.statsEl.empty();
        this.statsEl.addClass('btm-standardization-panel');

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

        // Fix Two: Inline Case Buttons
        const caseInBtns = caseBox.createDiv({ cls: 'btm-inline-case-btns' });
        const btnUpper = caseInBtns.createEl('button', { text: 'Convert to upper', cls: 'btm-mini-case-btn' });
        btnUpper.onclick = async () => { 
            new BtmConfirmationModal(
                this.app, 
                'Bulk Convert to UPPERCASE',
                'Are you sure you want to convert ALL tags in your vault to UPPERCASE? This action will modify multiple files.',
                async () => {
                    await this.plugin.convertAllToCase('uppercase');
                    this.updateStats().catch(e => console.error("Failed to update stats", e));
                }
            ).open();
        };
        const btnLower = caseInBtns.createEl('button', { text: 'Convert to lower', cls: 'btm-mini-case-btn' });
        btnLower.onclick = async () => { 
            new BtmConfirmationModal(
                this.app, 
                'Bulk Convert to lowercase',
                'Are you sure you want to convert ALL tags in your vault to lowercase? This action will modify multiple files.',
                async () => {
                    await this.plugin.convertAllToCase('lowercase');
                    this.updateStats().catch(e => console.error("Failed to update stats", e));
                }
            ).open();
        };

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
        specialBox.createDiv({ text: 'Clean tags and front matter', cls: 'btm-metric-label' });
        this.createProgressBar(specialBox, stats.specialCharStats.consistency);
        const specialDetails = specialBox.createDiv({ cls: 'btm-metric-details' });
        createStatLink(specialDetails, stats.specialCharStats.clean.length, 'clean tags', stats.specialCharStats.clean);
        createStatLink(specialDetails, stats.specialCharStats.withSpecial.length, 'with special chars', stats.specialCharStats.withSpecial);
        
        if (stats.quotedFrontmatterCount > 0) {
            const fmLink = specialDetails.createEl('a', { 
                text: `${stats.quotedFrontmatterCount} notes with quoted properties`, 
                cls: 'btm-stat-link btm-warning-link' 
            });
            fmLink.style.display = 'block';
            fmLink.style.marginTop = '4px';
            fmLink.onclick = () => {
                this.close();
                new SimpleFileListModal(this.app, 'Notes with Quoted Properties', stats.quotedFrontmatterFiles).open();
            };
        }

        // Tag Format Style
        const formatBox = this.metricsGrid.createDiv({ cls: 'btm-metric-box' });
        formatBox.createDiv({ text: 'Tag Format Style', cls: 'btm-metric-label' });

        const formatContent = formatBox.createDiv({ cls: 'btm-metric-details', attr: { style: 'display:block; margin-bottom: 5px;' } });

        const createFormatLink = (label: string, files: TFile[]) => {
            if (files.length > 0) {
                const link = formatContent.createEl('a', { text: `${label}: ${files.length} files`, cls: 'btm-stat-link', attr: { style: 'display:block;' } });
                link.onclick = () => {
                    this.close();
                    new SimpleFileListModal(this.app, label, files).open();
                };
            } else {
                formatContent.createDiv({ text: `${label}: 0 files`, attr: { style: 'color: var(--text-muted); font-size: var(--font-ui-smaller);' } });
            }
        };

        createFormatLink('YAML List', stats.formatStats.yamlList);
        createFormatLink('Inline Array', stats.formatStats.inlineArray);

        const formatActions = formatBox.createDiv({ cls: 'btm-format-actions', attr: { style: 'margin-top: auto; display: flex; flex-direction: column; gap: 4px;' } });

        const btnToInline = formatActions.createEl('button', { text: 'Convert All to Inline', cls: 'btm-small-btn' });
        btnToInline.onclick = async () => {
            new BtmConfirmationModal(
                this.app,
                'Convert to Inline Array',
                'Are you sure you want to convert ALL tags in these files to the [tag1, tag2] inline format?',
                async () => {
                    await this.plugin.convertTagFormat(files, 'inline');
                    this.updateStats().catch(e => console.error("Failed to update stats", e));
                }
            ).open();
        };

        const btnToList = formatActions.createEl('button', { text: 'Convert All to List', cls: 'btm-small-btn' });
        btnToList.onclick = async () => {
            new BtmConfirmationModal(
                this.app,
                'Convert to YAML List',
                'Are you sure you want to convert ALL tags in these files to the YAML list format?',
                async () => {
                    await this.plugin.convertTagFormat(files, 'list');
                    this.updateStats().catch(e => console.error("Failed to update stats", e));
                }
            ).open();
        };

        // Hierarchical stats
        const nestBox = this.metricsGrid.createDiv({ cls: 'btm-metric-box' });
        nestBox.createDiv({ text: 'Tag Nesting', cls: 'btm-metric-label' });
        const nestDetails = nestBox.createDiv({ cls: 'btm-metric-details' });
        // Only show flat/nested stats if there ARE nested tags
        if (stats.nestedFiles.length > 0) {
            createStatLink(nestDetails, stats.nestingStats.flat.length, 'flat', stats.nestingStats.flat);
        }

        if (stats.nestedFiles.length > 0) {
            const realNestedLink = nestDetails.createEl('a', { text: `${stats.nestedFiles.length} notes with nested tags`, cls: 'btm-stat-link' });
            realNestedLink.onclick = () => {
                this.close();
                new NestedFilesModal(this.app, stats.nestedFiles).open();
            };
        } else {
            nestDetails.createSpan({ text: '0 notes with nested tags' });
        }

        // Location Stats (Body vs Frontmatter)
        const locBox = this.metricsGrid.createDiv({ cls: 'btm-metric-box' });
        locBox.createDiv({ text: 'Locations', cls: 'btm-metric-label' });
        const locDetails = locBox.createDiv({ cls: 'btm-metric-details' });
        createStatLink(locDetails, stats.locationStats.frontmatter.length, 'frontmatter', stats.locationStats.frontmatter);
        createStatLink(locDetails, stats.locationStats.body.length, 'body', stats.locationStats.body);

        if (stats.inlineFiles.length > 0) {
            locBox.createDiv({ cls: 'btm-separator' }); // visual separator
            const nestedLink = locBox.createEl('a', {
                text: `${stats.inlineFiles.length} notes with tags in body`,
                cls: 'btm-stat-link',
                attr: { style: 'display:block; margin-top:4px;' }
            });
            nestedLink.onclick = () => {
                this.close();
                new InlineTagsModal(this.app, stats.inlineFiles).open();
            };
        }

        // Length stats
        const lengthBox = this.metricsGrid.createDiv({ cls: 'btm-metric-box' });
        lengthBox.createDiv({ text: 'Length', cls: 'btm-metric-label' });
        const lengthDetails = lengthBox.createDiv({ cls: 'btm-metric-details' });
        lengthDetails.createSpan({ text: `avg: ${stats.lengthStats.avgLength} chars ` });
        createStatLink(lengthDetails, stats.lengthStats.long.length, 'long (>25)', stats.lengthStats.long);

        // Async check for invalid tags
        this.checkInvalidTags().catch(e => console.error("Failed to check invalid tags", e));
        this.checkEmptyTags().catch(e => console.error("Failed to check empty tags", e));
    }

    async checkInvalidTags() {
        if (!this.invalidContentEl) return;
        this.invalidContentEl.empty();
        
        const invalidFiles = await this.plugin.findInvalidTagFormats();

        if (invalidFiles.length > 0) {
            this.invalidBlock.style.display = 'block';
            
            const warningRow = this.invalidContentEl.createDiv({ cls: 'btm-invalid-warning' });
            const iconEl = warningRow.createSpan({ cls: 'btm-icon' });
            setIcon(iconEl, 'alert-triangle');
            warningRow.createSpan({ text: ` ${invalidFiles.length} file${invalidFiles.length > 1 ? 's' : ''} with invalid tags` });

            const fixBtn = warningRow.createEl('button', { text: 'FIX INVALID', cls: 'mod-warning btm-fix-invalid-btn' });
            fixBtn.onclick = () => {
                this.close();
                new InvalidTagsModal(this.app, this.plugin, invalidFiles).open();
            };
            
            // Show a few examples
            const list = this.invalidContentEl.createDiv({ cls: 'btm-invalid-mini-list' });
            invalidFiles.slice(0, 3).forEach(f => {
                list.createDiv({ text: f.path, cls: 'btm-invalid-mini-item' });
            });
            if (invalidFiles.length > 3) {
                list.createDiv({ text: `... and ${invalidFiles.length - 3} more`, cls: 'btm-more' });
            }
        } else {
            this.invalidBlock.style.display = 'none';
        }
    }

    async checkEmptyTags() {
        const emptyFiles = await this.plugin.findEmptyTags();
        if (emptyFiles.length > 0) {
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
            .setDesc('Removes everything except letters, numbers, hyphens (-), and underscores (_).')
            .addToggle(toggle => toggle
                .setValue(this.plugin.settings.removeSpecialChars)
                .onChange(async (value) => {
                    this.plugin.settings.removeSpecialChars = value;
                    await this.plugin.saveSettings();
                }));

        new Setting(containerEl)
            .setName('Flatten Diacritics')
            .setDesc('Converts accented characters to their plain equivalents (e.g., á → a, å → a).')
            .addToggle(toggle => toggle
                .setValue(this.plugin.settings.flattenDiacritics)
                .onChange(async (value) => {
                    this.plugin.settings.flattenDiacritics = value;
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
            .setName('History Expiration (Days)')
            .setDesc('Automatically delete history older than this many days (0 to disable).')
            .addSlider(slider => slider
                .setLimits(0, 30, 1)
                .setValue(this.plugin.settings.historyExpirationDays)
                .setDynamicTooltip()
                .onChange(async (value) => {
                    this.plugin.settings.historyExpirationDays = value;
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

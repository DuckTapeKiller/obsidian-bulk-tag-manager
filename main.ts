import { App, Modal, Notice, Plugin, PluginSettingTab, Setting, TFile, TextComponent, SuggestModal, TFolder, setIcon, parseYaml, stringifyYaml } from 'obsidian';

// --- Interfaces ---

interface OperationRecord {
    id: string;
    type: 'rename' | 'merge' | 'convert' | 'pattern' | 'delete';
    timestamp: number;
    description: string;
    changes: FileChange[];
}

interface FileChange {
    path: string;
    before: string;
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
    caseStats: { lowercase: string[]; uppercase: string[]; mixed: string[]; consistency: number; };
    separatorStats: { underscore: string[]; hyphen: string[]; both: string[]; none: string[]; consistency: number; };
    specialCharStats: { withSpecial: string[]; clean: string[]; consistency: number; };
    nestingStats: { nested: string[]; flat: string[]; maxDepth: number; };
    lengthStats: { short: string[]; medium: string[]; long: string[]; avgLength: number; };
    locationStats: { frontmatter: string[]; body: string[]; };
    formatStats: { yamlList: TFile[]; inlineArray: TFile[]; };
    inlineFiles: { file: TFile; count: number; tags: string[] }[];
    nestedFiles: { file: TFile; count: number; tags: string[] }[];
}

interface InvalidTagFile {
    path: string;
    file: TFile;
    issues: string[];
}

interface VaultReport {
    totalTags: number;
    stats: TagStandardizationStats;
    invalidFiles: InvalidTagFile[];
    emptyFields: TFile[];
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
    scopeFilter: { enabled: false, includeFolders: [], excludeFolders: [], filePattern: '' },
    orphanThreshold: 2,
    maxHistorySize: 50
};

// --- Plugin Main Class ---

export default class TagLowercasePlugin extends Plugin {
    settings: TagLowercaseSettings;

    async onload() {
        await this.loadSettings();
        this.addRibbonIcon('tags', 'Bulk Tag Manager', () => { new TagManagerModal(this.app, this).open(); });
        this.addCommand({ id: 'open-bulk-tag-manager', name: 'Open Tag Manager Dashboard', callback: () => { new TagManagerModal(this.app, this).open(); } });
        this.addSettingTab(new TagLowercaseSettingTab(this.app, this));
    }

    async loadSettings() { this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData()); }
    async saveSettings() { await this.saveData(this.settings); }

    getFilteredFiles(): TFile[] {
        let files = this.app.vault.getMarkdownFiles();
        if (this.settings.scopeFilter.enabled) {
            const { includeFolders, excludeFolders, filePattern } = this.settings.scopeFilter;
            files = files.filter(f => {
                const path = f.path.toLowerCase();
                const inInclude = includeFolders.length === 0 || includeFolders.some(folder => path.startsWith(folder.toLowerCase()));
                const inExclude = excludeFolders.length > 0 && excludeFolders.some(folder => path.startsWith(folder.toLowerCase()));
                const matchPattern = !filePattern || f.name.includes(filePattern);
                return inInclude && !inExclude && matchPattern;
            });
        }
        return files;
    }

    // --- Master Diagnostic Engine ---

    async generateVaultReport(files: TFile[]): Promise<VaultReport> {
        const tags = Object.keys(this.app.metadataCache.getTags() || {});
        const totalTags = tags.length;

        const report: VaultReport = {
            totalTags,
            stats: {
                totalTags,
                caseStats: { lowercase: [], uppercase: [], mixed: [], consistency: 100 },
                separatorStats: { underscore: [], hyphen: [], both: [], none: [], consistency: 100 },
                specialCharStats: { withSpecial: [], clean: [], consistency: 100 },
                nestingStats: { nested: [], flat: [], maxDepth: 0 },
                lengthStats: { short: [], medium: [], long: [], avgLength: 0 },
                locationStats: { frontmatter: [], body: [] },
                formatStats: { yamlList: [], inlineArray: [] },
                inlineFiles: [],
                nestedFiles: []
            },
            invalidFiles: [],
            emptyFields: []
        };

        if (totalTags === 0 && files.length === 0) return report;

        // 1. Static Tag Analysis
        let totalLength = 0;
        const FM_MATCH = /^---\n([\s\S]*?)\n---\n/;
        const INVALID_CHARS_REGEX = /[!'@#$%^&*()={}\[\]:;"<>,.?~`]/;
        const PURE_NUMERIC = /^\d+$/;

        for (const tag of tags) {
            const raw = tag.startsWith('#') ? tag.substring(1) : tag;
            totalLength += raw.length;
            const letters = raw.replace(/[^a-zA-Z]/g, '');
            if (letters.length > 0) {
                const isAllLower = letters === letters.toLowerCase();
                const isAllUpper = letters === letters.toUpperCase();
                if (isAllLower && !isAllUpper) report.stats.caseStats.lowercase.push(tag);
                else if (isAllUpper && !isAllLower) report.stats.caseStats.uppercase.push(tag);
                else report.stats.caseStats.mixed.push(tag);
            } else { report.stats.caseStats.lowercase.push(tag); }

            const hasUnderscore = raw.includes('_');
            const hasHyphen = raw.includes('-');
            if (hasUnderscore && hasHyphen) report.stats.separatorStats.both.push(tag);
            else if (hasUnderscore) report.stats.separatorStats.underscore.push(tag);
            else if (hasHyphen) report.stats.separatorStats.hyphen.push(tag);
            else report.stats.separatorStats.none.push(tag);

            if (INVALID_CHARS_REGEX.test(raw)) report.stats.specialCharStats.withSpecial.push(tag);
            else report.stats.specialCharStats.clean.push(tag);

            const depth = (raw.match(/\//g) || []).length + 1;
            if (depth > 1) report.stats.nestingStats.nested.push(tag); else report.stats.nestingStats.flat.push(tag);
            report.stats.nestingStats.maxDepth = Math.max(report.stats.nestingStats.maxDepth, depth);

            if (raw.length <= 10) report.stats.lengthStats.short.push(tag);
            else if (raw.length <= 25) report.stats.lengthStats.medium.push(tag);
            else report.stats.lengthStats.long.push(tag);
        }
        report.stats.lengthStats.avgLength = totalTags > 0 ? Math.round(totalLength / totalTags) : 0;

        // 2. Single-Pass File Audit
        const fmTagsSet = new Set<string>();
        const bodyTagsSet = new Set<string>();

        for (const file of files) {
            const cache = this.app.metadataCache.getFileCache(file);
            if (!cache) continue;

            const fileInlineSet = new Set<string>();
            const fileNestedSet = new Set<string>();

            if (cache.tags) {
                cache.tags.forEach(t => {
                    const clean = t.tag.startsWith('#') ? t.tag.substring(1) : t.tag;
                    bodyTagsSet.add(clean);
                    fileInlineSet.add(clean);
                    if (clean.includes('/')) fileNestedSet.add(clean);
                });
            }

            const fm = cache.frontmatter;
            if (fm) {
                const hasTagsKey = 'tags' in fm;
                const hasTagKey = 'tag' in fm;
                const getTags = (v: any) => (typeof v === 'string' ? v.split(',').map(s => s.trim()) : Array.isArray(v) ? v.map(String) : []);
                const fmList = [...getTags(fm.tags), ...getTags(fm.tag)];
                fmList.forEach(t => {
                    const clean = t.startsWith('#') ? t.substring(1) : t;
                    fmTagsSet.add(clean);
                    if (clean.includes('/')) fileNestedSet.add(clean);
                });

                if (hasTagsKey || hasTagKey) {
                    const val = hasTagsKey ? fm.tags : fm.tag;
                    if (val === null || val === undefined || (Array.isArray(val) && val.length === 0) || (typeof val === 'string' && val.trim().length === 0)) {
                        report.emptyFields.push(file);
                    }
                    try {
                        const content = await this.app.vault.read(file);
                        const match = content.match(FM_MATCH);
                        if (match) {
                            const lines = match[1].split('\n');
                            const issues: string[] = [];
                            let inList = false;
                            for (const line of lines) {
                                const keyMatch = line.match(/^(tags?):(.*)$/i);
                                if (keyMatch) {
                                    const value = keyMatch[2].trim();
                                    if (value.startsWith('[')) report.stats.formatStats.inlineArray.push(file);
                                    if (value.startsWith('[')) {
                                        value.replace(/[\[\]]/g, '').split(',').forEach(t => {
                                            const err = this.validateTagString(t, INVALID_CHARS_REGEX, PURE_NUMERIC);
                                            if (err) issues.push(err);
                                        });
                                    } else if (!value) { inList = true; } else {
                                        if (value.includes(',')) issues.push(`"${keyMatch[1]}" uses comma-separated format instead of YAML array`);
                                        const err = this.validateTagString(value, INVALID_CHARS_REGEX, PURE_NUMERIC);
                                        if (err) issues.push(err);
                                    }
                                } else if (inList && line.trim().startsWith('-')) {
                                    report.stats.formatStats.yamlList.push(file);
                                    const err = this.validateTagString(line.trim().substring(1).trim(), INVALID_CHARS_REGEX, PURE_NUMERIC);
                                    if (err) issues.push(err);
                                } else if (line.trim().length > 0 && !line.startsWith(' ') && !line.startsWith('\t')) { inList = false; }
                            }
                            if (issues.length > 0) report.invalidFiles.push({ path: file.path, file, issues: [...new Set(issues)] });
                        }
                    } catch (e) {}
                }
            }
            if (fileInlineSet.size > 0) report.stats.inlineFiles.push({ file, count: fileInlineSet.size, tags: Array.from(fileInlineSet).sort() });
            if (fileNestedSet.size > 0) report.stats.nestedFiles.push({ file, count: fileNestedSet.size, tags: Array.from(fileNestedSet).sort() });
        }
        report.stats.locationStats.frontmatter = Array.from(fmTagsSet).sort();
        report.stats.locationStats.body = Array.from(bodyTagsSet).sort();
        const calcCons = (arrs: string[][]) => {
            const dom = Math.max(...arrs.map(a => a.length));
            return totalTags > 0 ? Math.round((dom / totalTags) * 100) : 100;
        };
        report.stats.caseStats.consistency = calcCons([report.stats.caseStats.lowercase, report.stats.caseStats.uppercase, report.stats.caseStats.mixed]);
        report.stats.specialCharStats.consistency = calcCons([report.stats.specialCharStats.clean]);
        return report;
    }

    private validateTagString(t: string, invalidChars: RegExp, pureNum: RegExp): string | null {
        const tr = t.trim().replace(/^['"]|['"]$/g, '');
        if (!tr) return null;
        if (tr.includes(' ')) return `Tag "${tr}" contains spaces`;
        if (tr.includes("'")) return `Tag "${tr}" contains apostrophes`;
        if (invalidChars.test(tr)) return `Tag "${tr}" contains invalid characters`;
        if (pureNum.test(tr)) return `Tag "${tr}" is purely numeric`;
        return null;
    }

    // --- Master Repair Utility ---

    async fixAndStandardizeTags(file: TFile): Promise<boolean> {
        let modified = false;
        await this.app.vault.process(file, (content) => {
            const match = content.match(/^---\n([\s\S]*?)\n---\n/);
            if (!match) return content;
            const body = content.slice(match[0].length);
            try {
                const fm = parseYaml(match[1]);
                let fmModified = false;
                const reg = /[!'@#$%^&*()={}\[\]:;"<>,.?~`]/g;
                const fix = (t: any): string | null => {
                    if (typeof t !== 'string' || /^\d+$/.test(t.trim())) return null;
                    const tri = t.trim(); if (!tri) return null;
                    let f = tri.replace(reg, '').replace(/\s+/g, '-');
                    return f.length > 0 ? f : null;
                };
                const proc = (v: any) => {
                    if (typeof v === 'string' && v.includes(',')) { fmModified = true; return v.split(',').map(fix).filter(s => s !== null); }
                    if (Array.isArray(v)) {
                        const res = v.map(fix).filter(s => s !== null);
                        if (JSON.stringify(res) !== JSON.stringify(v)) fmModified = true;
                        return res;
                    }
                    if (typeof v === 'string') { const f = fix(v); if (f !== v) fmModified = true; return f || []; }
                    return v;
                };
                if (fm.tags) fm.tags = proc(fm.tags); if (fm.tag) fm.tag = proc(fm.tag);
                if (fmModified) { modified = true; return `---\n${stringifyYaml(fm)}---\n${body}`; }
            } catch (e) {}
            return content;
        });
        return modified;
    }

    async standardizeAllTags() {
        const files = this.getFilteredFiles();
        const progress = new ProgressModal(this.app, files.length); progress.open();
        let count = 0; let modified = 0;
        for (const file of files) {
            if (await this.fixAndStandardizeTags(file)) modified++;
            count++; progress.update(count);
        }
        progress.close(); new Notice(`Standardized ${modified} files.`);
    }

    // --- Operations ---

    async renameTag(oldT: string, newT: string) {
        const files = this.getFilteredFiles();
        let changes: FileChange[] = [];
        const oldRaw = oldT.replace(/^#/, '');
        const newRaw = newT.replace(/^#/, '');
        for (const file of files) {
            const before = await this.app.vault.read(file);
            let modified = false;
            await this.app.vault.process(file, (data) => {
                const match = data.match(/^---\n([\s\S]*?)\n---\n/);
                let res = data;
                if (match) {
                    try {
                        const fm = parseYaml(match[1]);
                        const rep = (v: any) => Array.isArray(v) ? v.map(t => String(t) === oldRaw ? newRaw : t) : (String(v) === oldRaw ? newRaw : v);
                        if (fm.tags) fm.tags = rep(fm.tags); if (fm.tag) fm.tag = rep(fm.tag);
                        res = `---\n${stringifyYaml(fm)}---\n${data.slice(match[0].length)}`;
                    } catch (e) {}
                }
                const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
                const reg = new RegExp(`(^|\\s|\\(|\\[|\\{)#${esc(oldRaw)}(?=$|[\\s\\)\\}\\]\\.,?!:;])`, 'gu');
                const final = res.replace(reg, `$1#${newRaw}`);
                if (final !== data) modified = true;
                return final;
            });
            if (modified) changes.push({ path: file.path, before });
        }
        if (changes.length > 0) { await this.addToHistory({ type: 'rename', description: `Rename #${oldRaw} to #${newRaw}`, changes }); new Notice(`Renamed in ${changes.length} files.`); }
    }

    async mergeTags(sources: string[], target: string) {
        const files = this.getFilteredFiles();
        let changes: FileChange[] = [];
        const srcRaws = sources.map(s => s.trim().replace(/^#/, ''));
        const tgtRaw = target.replace(/^#/, '');
        for (const file of files) {
            const before = await this.app.vault.read(file);
            let modified = false;
            await this.app.vault.process(file, (data) => {
                let res = data;
                const match = data.match(/^---\n([\s\S]*?)\n---\n/);
                if (match) {
                    try {
                        const fm = parseYaml(match[1]);
                        const merge = (v: any) => {
                            if (!v) return v;
                            const list = Array.isArray(v) ? v.map(String) : [String(v)];
                            const newList = list.map(t => srcRaws.includes(t) ? tgtRaw : t);
                            const dedup = [...new Set(newList)];
                            return Array.isArray(v) ? dedup : dedup[0];
                        };
                        if (fm.tags) fm.tags = merge(fm.tags); if (fm.tag) fm.tag = merge(fm.tag);
                        res = `---\n${stringifyYaml(fm)}---\n${data.slice(match[0].length)}`;
                    } catch (e) {}
                }
                srcRaws.forEach(s => {
                    const esc = (str: string) => str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
                    const reg = new RegExp(`(^|\\s|\\(|\\[|\\{)#${esc(s)}(?=$|[\\s\\)\\}\\]\\.,?!:;])`, 'gu');
                    res = res.replace(reg, `$1#${tgtRaw}`);
                });
                if (res !== data) modified = true;
                return res;
            });
            if (modified) changes.push({ path: file.path, before });
        }
        if (changes.length > 0) { await this.addToHistory({ type: 'merge', description: `Merge ${sources.join(', ')} into #${tgtRaw}`, changes }); new Notice(`Merged in ${changes.length} files.`); }
    }

    async deleteTags(tagsToDelete: string[]) {
        const files = this.getFilteredFiles();
        let changes: FileChange[] = [];
        const raws = tagsToDelete.map(t => t.trim().replace(/^#/, ''));
        for (const file of files) {
            const before = await this.app.vault.read(file);
            let modified = false;
            await this.app.vault.process(file, (data) => {
                let res = data;
                const match = data.match(/^---\n([\s\S]*?)\n---\n/);
                if (match) {
                    try {
                        const fm = parseYaml(match[1]);
                        const del = (v: any) => {
                            if (!v) return v;
                            const list = Array.isArray(v) ? v.map(String) : [String(v)];
                            const filtered = list.filter(t => !raws.includes(t));
                            if (Array.isArray(v)) return filtered;
                            return filtered.length > 0 ? filtered[0] : null;
                        };
                        if (fm.tags) fm.tags = del(fm.tags); if (fm.tag) fm.tag = del(fm.tag);
                        res = `---\n${stringifyYaml(fm)}---\n${data.slice(match[0].length)}`;
                    } catch (e) {}
                }
                raws.forEach(s => {
                    const esc = (str: string) => str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
                    const reg = new RegExp(`(^|\\s|\\(|\\[|\\{)#${esc(s)}(?=$|[\\s\\)\\}\\]\\.,?!:;])`, 'gu');
                    res = res.replace(reg, `$1`);
                });
                if (res !== data) modified = true;
                return res;
            });
            if (modified) changes.push({ path: file.path, before });
        }
        if (changes.length > 0) { await this.addToHistory({ type: 'delete', description: `Delete ${tagsToDelete.join(', ')}`, changes }); new Notice(`Deleted in ${changes.length} files.`); }
    }

    async batchRename(pattern: string, replacement: string) {
        const files = this.getFilteredFiles();
        let changes: FileChange[] = [];
        const regex = new RegExp(pattern, 'u');
        for (const file of files) {
            const before = await this.app.vault.read(file);
            let modified = false;
            await this.app.vault.process(file, (data) => {
                let res = data;
                const match = data.match(/^---\n([\s\S]*?)\n---\n/);
                if (match) {
                    try {
                        const fm = parseYaml(match[1]);
                        const rep = (v: any) => {
                            if (!v) return v;
                            const list = Array.isArray(v) ? v.map(String) : [String(v)];
                            const mapped = list.map(t => t.replace(regex, replacement));
                            return Array.isArray(v) ? mapped : mapped[0];
                        };
                        if (fm.tags) fm.tags = rep(fm.tags); if (fm.tag) fm.tag = rep(fm.tag);
                        res = `---\n${stringifyYaml(fm)}---\n${data.slice(match[0].length)}`;
                    } catch (e) {}
                }
                const tagReg = /(^|[\s\(\[\{])#([\p{L}\p{N}_\-\/]+)(?=$|[\s\)\}\],\.?!:;])/gu;
                const final = res.replace(tagReg, (m, prefix, tag) => prefix + '#' + tag.replace(regex, replacement));
                if (final !== data) modified = true;
                return final;
            });
            if (modified) changes.push({ path: file.path, before });
        }
        if (changes.length > 0) { await this.addToHistory({ type: 'pattern', description: `Pattern ${pattern} → ${replacement}`, changes }); new Notice(`Processed ${changes.length} files.`); }
    }

    async convertTagFormat(files: TFile[], format: 'inline' | 'list') {
        let count = 0;
        for (const file of files) {
            await this.app.vault.process(file, (data) => {
                const match = data.match(/^---\n([\s\S]*?)\n---\n/);
                if (!match) return data;
                try {
                    const fm = parseYaml(match[1]);
                    const key = fm.tags ? 'tags' : (fm.tag ? 'tag' : null);
                    if (!key) return data;
                    let tags = fm[key]; if (typeof tags === 'string') tags = tags.split(',').map(s => s.trim());
                    if (!Array.isArray(tags)) tags = [tags];
                    tags = tags.filter(t => t && String(t).trim());
                    if (tags.length === 0) return data;
                    fm[key] = tags;
                    count++;
                    return `---\n${stringifyYaml(fm)}---\n${data.slice(match[0].length)}`;
                } catch (e) { return data; }
            });
        }
        new Notice(`Converted to ${format} in ${count} files.`);
    }

    findOrphanedTags(): { tag: string; count: number }[] {
        const tags = this.app.metadataCache.getTags() || {};
        return Object.entries(tags)
            .filter(([, count]) => count < this.settings.orphanThreshold)
            .map(([tag, count]) => ({ tag, count: count as number }))
            .sort((a, b) => a.count - b.count);
    }

    // --- History ---

    async addToHistory(record: Omit<OperationRecord, 'id' | 'timestamp'>) {
        const full: OperationRecord = { ...record, id: Math.random().toString(36).substring(2, 9), timestamp: Date.now() };
        this.settings.operationHistory.unshift(full);
        if (this.settings.operationHistory.length > this.settings.maxHistorySize) this.settings.operationHistory.pop();
        await this.saveSettings();
    }

    async undoLastOperation() {
        const op = this.settings.operationHistory.shift();
        if (!op) return;
        for (const change of op.changes) {
            const file = this.app.vault.getAbstractFileByPath(change.path);
            if (file instanceof TFile) await this.app.vault.modify(file, change.before);
        }
        await this.saveSettings(); new Notice(`Undid: ${op.description}`);
    }

    // --- Utilities ---

    async runConversionWithPreview() {
        const preview = await this.previewConversion();
        if (preview.affectedFiles.length === 0) { new Notice('No changes needed.'); return; }
        new PreviewModal(this.app, this, preview, (files) => this.executeConversion(files)).open();
    }

    async previewConversion(): Promise<PreviewResult> {
        const files = this.getFilteredFiles();
        let affectedFiles: PreviewFile[] = [];
        let totalChanges = 0;
        for (const file of files) {
            const current = await this.app.vault.read(file);
            const processed = this.processRawContent(current);
            if (current !== processed) {
                const diff = this.computeDiff(current, processed);
                affectedFiles.push({ path: file.path, changes: diff, included: true });
                totalChanges += diff.length;
            }
        }
        return { affectedFiles, totalChanges };
    }

    async executeConversion(files: PreviewFile[]) {
        const progress = new ProgressModal(this.app, files.length); progress.open();
        let count = 0; let changes: FileChange[] = [];
        for (const pf of files) {
            const file = this.app.vault.getAbstractFileByPath(pf.path);
            if (file instanceof TFile) {
                const before = await this.app.vault.read(file);
                await this.app.vault.process(file, (d) => this.processRawContent(d));
                changes.push({ path: file.path, before });
            }
            count++; progress.update(count);
        }
        progress.close();
        if (changes.length > 0) { await this.addToHistory({ type: 'convert', description: 'Global Conversion', changes }); new Notice(`Converted ${changes.length} files.`); }
    }

    private processRawContent(data: string): string {
        let res = data;
        const match = data.match(/^---\n([\s\S]*?)\n---\n/);
        if (match) {
            try {
                const fm = parseYaml(match[1]);
                let fmMod = false;
                const proc = (t: any): string | null => {
                    if (typeof t !== 'string') return t;
                    const parts = t.split('/');
                    const fixed = parts.map(p => {
                        let s = p;
                        if (this.settings.removeSpecialChars) s = s.replace(/[^\p{L}\p{N}\-_]/gu, '');
                        if (this.settings.separatorStrategy === 'snake') s = s.replace(/-/g, '_');
                        else if (this.settings.separatorStrategy === 'kebab') s = s.replace(/_/g, '-');
                        if (this.settings.caseStrategy === 'lowercase') s = s.toLowerCase();
                        else if (this.settings.caseStrategy === 'uppercase') s = s.toUpperCase();
                        return s;
                    }).join('/');
                    if (fixed !== t) fmMod = true;
                    return fixed;
                };
                const depthProc = (v: any) => Array.isArray(v) ? v.map(proc) : proc(v);
                if (fm.tags) fm.tags = depthProc(fm.tags); if (fm.tag) fm.tag = depthProc(fm.tag);
                if (fmMod) res = `---\n${stringifyYaml(fm)}---\n${data.slice(match[0].length)}`;
            } catch (e) {}
        }
        const tagReg = /(^|[\s\(\[\{])#([\p{L}\p{N}_\-\/]+)(?=$|[\s\)\}\],\.?!:;])/gu;
        return res.replace(tagReg, (m, prefix, tag) => {
            const parts = tag.split('/');
            const processed = parts.map(p => {
                let s = p;
                if (this.settings.removeSpecialChars) s = s.replace(/[^\p{L}\p{N}\-_]/gu, '');
                if (this.settings.separatorStrategy === 'snake') s = s.replace(/-/g, '_');
                else if (this.settings.separatorStrategy === 'kebab') s = s.replace(/_/g, '-');
                if (this.settings.caseStrategy === 'lowercase') s = s.toLowerCase();
                else if (this.settings.caseStrategy === 'uppercase') s = s.toUpperCase();
                return s;
            }).join('/');
            return prefix + '#' + processed;
        });
    }

    private computeDiff(oldC: string, newC: string) {
        const oldL = oldC.split('\n'); const newL = newC.split('\n');
        let diff: { line: number, before: string, after: string }[] = [];
        for (let i = 0; i < Math.max(oldL.length, newL.length); i++) {
            if (oldL[i] !== newL[i]) diff.push({ line: i + 1, before: oldL[i] || '', after: newL[i] || '' });
        }
        return diff;
    }

    getTagHierarchy(): TagNode[] {
        const tags = this.app.metadataCache.getTags() || {};
        const root: TagNode[] = [];
        for (const [tag, count] of Object.entries(tags)) {
            const parts = tag.substring(1).split('/');
            let lvl = root; let pth = '';
            for (let i = 0; i < parts.length; i++) {
                pth = pth ? `${pth}/${parts[i]}` : parts[i];
                let node = lvl.find(n => n.name === parts[i]);
                if (!node) { node = { name: parts[i], fullPath: pth, count: 0, children: [] }; lvl.push(node); }
                if (i === parts.length - 1) node.count = count;
                lvl = node.children;
            }
        }
        return root;
    }

    async generateTagList() {
        const tags = Object.keys(this.app.metadataCache.getTags() || {}).map(t => t.substring(1)).sort();
        const content = tags.join('\n');
        const file = await this.app.vault.create('tag_list.md', content);
        this.app.workspace.getLeaf(false).openFile(file);
    }

    getAllTags(): string[] {
        const tags = this.app.metadataCache.getTags() || {};
        return Object.keys(tags).map(t => t.substring(1)).sort();
    }
}

// --- Modals ---

class TagManagerModal extends Modal {
    plugin: TagLowercasePlugin;
    statsEl: HTMLElement;
    metricsGrid: HTMLElement;
    findInput: TextComponent;
    replaceInput: TextComponent;
    mergeSourcesInput: TextComponent;
    mergeTargetInput: TextComponent;
    deleteInput: TextComponent;

    constructor(app: App, plugin: TagLowercasePlugin) { super(app); this.plugin = plugin; }

    onOpen() {
        const { contentEl } = this; contentEl.empty(); contentEl.addClass('btm-dashboard');
        new Setting(contentEl).setName('Bulk Tag Manager Dashboard').setHeading().addExtraButton(b => {
            b.setIcon('refresh-cw').setTooltip('Refresh Stats').onClick(() => this.updateStats());
        });
        this.statsEl = contentEl.createDiv({ cls: 'btm-stats-area' });
        this.updateStats();

        // Actions Panel
        const actions = contentEl.createDiv({ cls: 'btm-actions-panel' });
        
        // Rename
        const renameBox = actions.createDiv({ cls: 'btm-section-box btm-bg-primary' });
        renameBox.createDiv({ cls: 'btm-collapsible-header' }).createSpan({ text: 'Rename Tag' });
        const renameRow = renameBox.createDiv({ cls: 'btm-aligned-row' });
        const fld1 = renameRow.createDiv({ cls: 'btm-field-column' }); fld1.createEl('label', { text: 'Find' });
        this.findInput = new TextComponent(fld1).setPlaceholder('#old-tag');
        const fld2 = renameRow.createDiv({ cls: 'btm-field-column' }); fld2.createEl('label', { text: 'Replace' });
        this.replaceInput = new TextComponent(fld2).setPlaceholder('#new-tag');
        const btnRen = renameRow.createEl('button', { text: 'Rename', cls: 'mod-cta btm-action-btn' });
        btnRen.onclick = async () => { if (this.findInput.getValue() && this.replaceInput.getValue()) { this.close(); await this.plugin.renameTag(this.findInput.getValue(), this.replaceInput.getValue()); } };

        // Merge
        const mergeBox = actions.createDiv({ cls: 'btm-section-box btm-bg-secondary' });
        mergeBox.createDiv({ cls: 'btm-collapsible-header' }).createSpan({ text: 'Merge Tags' });
        const mergeRow = mergeBox.createDiv({ cls: 'btm-aligned-row' });
        const mfld1 = mergeRow.createDiv({ cls: 'btm-field-column' }); mfld1.createEl('label', { text: 'Sources' });
        this.mergeSourcesInput = new TextComponent(mfld1).setPlaceholder('#t1, #t2');
        const mfld2 = mergeRow.createDiv({ cls: 'btm-field-column' }); mfld2.createEl('label', { text: 'Target' });
        this.mergeTargetInput = new TextComponent(mfld2).setPlaceholder('#merged');
        const btnM = mergeRow.createEl('button', { text: 'Merge', cls: 'mod-cta btm-action-btn' });
        btnM.onclick = async () => { if (this.mergeSourcesInput.getValue() && this.mergeTargetInput.getValue()) { this.close(); await this.plugin.mergeTags(this.mergeSourcesInput.getValue().split(','), this.mergeTargetInput.getValue()); } };

        // Delete
        const delBox = actions.createDiv({ cls: 'btm-section-box btm-bg-primary' });
        delBox.createDiv({ cls: 'btm-collapsible-header' }).createSpan({ text: 'Delete Tags' });
        const delRow = delBox.createDiv({ cls: 'btm-aligned-row' });
        const dfld1 = delRow.createDiv({ cls: 'btm-field-column' }); dfld1.setAttr('style', 'grid-column: span 2;'); dfld1.createEl('label', { text: 'Tags to Delete (comma separated)' });
        this.deleteInput = new TextComponent(dfld1).setPlaceholder('#bad1, #bad2'); this.deleteInput.inputEl.style.width = '100%';
        const btnD = delRow.createEl('button', { text: 'Delete', cls: 'mod-warning btm-action-btn' });
        btnD.onclick = async () => { if (this.deleteInput.getValue()) { this.close(); await this.plugin.deleteTags(this.deleteInput.getValue().split(',')); } };

        // Engine
        const engBox = actions.createDiv({ cls: 'btm-section-box btm-bg-secondary' });
        engBox.createDiv({ cls: 'btm-collapsible-header' }).createSpan({ text: 'Standardization Engine' });
        const engActions = engBox.createDiv({ cls: 'btm-action-row' });
        this.createIconButton(engActions, 'refresh-cw', 'Global Conversion', 'mod-cta').onclick = async () => { this.close(); await this.plugin.runConversionWithPreview(); };
        this.createIconButton(engActions, 'check-square', 'Fix Format').onclick = async () => { this.close(); await this.plugin.standardizeAllTags(); };

        // Tools
        const toolsBox = actions.createDiv({ cls: 'btm-section-box btm-bg-primary' });
        toolsBox.createDiv({ cls: 'btm-collapsible-header' }).createSpan({ text: 'Tools' });
        const toolsActions = toolsBox.createDiv({ cls: 'btm-action-row' });
        this.createIconButton(toolsActions, 'git-branch', 'Hierarchy').onclick = () => { this.close(); new TagHierarchyModal(this.app, this.plugin).open(); };
        this.createIconButton(toolsActions, 'alert-circle', 'Orphans').onclick = () => { this.close(); new OrphanTagsModal(this.app, this.plugin).open(); };
        this.createIconButton(toolsActions, 'history', 'History').onclick = () => { this.close(); new HistoryModal(this.app, this.plugin).open(); };
    }

    async updateStats() {
        this.statsEl.empty(); const files = this.plugin.getFilteredFiles();
        const report = await this.plugin.generateVaultReport(files);
        const stats = report.stats;
        let health = 100; if (stats.totalTags > 0) health = Math.max(0, Math.min(100, Math.round(((stats.totalTags - report.invalidFiles.length * 10)/stats.totalTags)*100)));
        if (report.invalidFiles.length > 0 && health >= 100) health = 98;
        this.renderHeader(stats.totalTags, files.length);
        this.metricsGrid = this.statsEl.createDiv({ cls: 'btm-metrics-grid' });
        this.renderMetricBox('Empty Tag Fields', `${report.emptyFields.length} files`, 'Tags key but no values', () => { if (report.emptyFields.length > 0) { this.close(); new SimpleFileListModal(this.app, 'Empty Tag Fields', report.emptyFields).open(); }});
        this.renderMetricBox('Case Consistency', `${stats.caseStats.consistency}%`, 'lower/UPPER/Mixed', null, (c) => {
            this.createProgressBar(c, stats.caseStats.consistency);
            const d = c.createDiv({ cls: 'btm-metric-details' });
            this.renderStatLinks(d, [{ count: stats.caseStats.lowercase.length, label: 'lower', tags: stats.caseStats.lowercase }, { count: stats.caseStats.uppercase.length, label: 'UPPER', tags: stats.caseStats.uppercase }]);
        });
        this.renderMetricBox('Separators', `${stats.separatorStats.consistency}%`, 'Hyphens vs Underscores', null, (c) => {
            this.createProgressBar(c, stats.separatorStats.consistency);
            const d = c.createDiv({ cls: 'btm-metric-details' });
            this.renderStatLinks(d, [{ count: stats.separatorStats.hyphen.length, label: 'hyphenated', tags: stats.separatorStats.hyphen }, { count: stats.separatorStats.underscore.length, label: 'underscored', tags: stats.separatorStats.underscore }]);
        });
        this.renderMetricBox('Locations', `${stats.locationStats.frontmatter.length} FM / ${stats.locationStats.body.length} Body`, 'FM vs Body', null, (c) => {
            const d = c.createDiv({ cls: 'btm-metric-details' });
            this.renderStatLinks(d, [{ count: stats.locationStats.frontmatter.length, label: 'Frontmatter', tags: stats.locationStats.frontmatter }, { count: stats.locationStats.body.length, label: 'Body', tags: stats.locationStats.body }]);
        });
        this.renderTagHealthSection(report.invalidFiles, report.emptyFields, health);
    }

    renderHeader(tc: number, fc: number) {
        const h = this.statsEl.createDiv({ cls: 'btm-stats-header' });
        const ts = h.createSpan({ cls: 'btm-stat-item' }); setIcon(ts.createSpan(), 'tags'); ts.createSpan({ text: ` ${tc} tags` });
        const fs = h.createSpan({ cls: 'btm-stat-item' }); setIcon(fs.createSpan(), 'files'); fs.createSpan({ text: ` ${fc} files` });
    }

    renderMetricBox(label: string, val: string, sub: string, onClick?: () => void, custom?: (c: HTMLElement) => void) {
        const b = this.metricsGrid.createDiv({ cls: 'btm-metric-box' }); b.createDiv({ text: label, cls: 'btm-metric-label' });
        const d = b.createDiv({ cls: 'btm-metric-details' });
        if (custom) custom(b); else { if (onClick) { const a = d.createEl('a', { text: val, cls: 'btm-stat-link' }); a.onclick = onClick; } else d.createSpan({ text: val }); d.createDiv({ text: sub, cls: 'btm-metric-subtext' }); }
    }

    renderStatLinks(cont: HTMLElement, lnks: { count: number, label: string, tags: string[] }[]) {
        lnks.forEach(l => { if (l.count > 0) { const a = cont.createEl('a', { text: `${l.count} ${l.label}`, cls: 'btm-stat-link' }); a.onclick = () => { this.close(); new TagListModal(this.app, l.label, l.tags).open(); }; cont.appendText(' '); }});
    }

    renderTagHealthSection(invalids: InvalidTagFile[], empties: TFile[], score: number) {
        const section = this.statsEl.createDiv({ cls: 'btm-health-section btm-section-box btm-bg-secondary' });
        const header = section.createDiv({ cls: 'btm-collapsible-header' });
        const left = header.createDiv({ attr: { style: 'display:flex; align-items:center; gap:12px' }});
        left.createSpan({ text: 'Tag Health & Audit' });
        left.createSpan({ text: `Health: ${score}%`, attr: { style: `font-size:11px; padding:2px 8px; border-radius:10px; background:${score>90?'var(--color-green)':score>70?'var(--color-yellow)':'var(--color-red)'}; color:white; font-weight:600` }});
        const content = section.createDiv({ cls: 'btm-collapsible-content is-collapsed' });
        header.onclick = () => content.classList.toggle('is-collapsed');
        const grid = content.createDiv({ cls: 'btm-audit-grid' });
        const box = grid.createDiv({ cls: 'btm-audit-box' });
        if (invalids.length === 0) box.createDiv({ text: 'No formatting issues', cls: 'btm-audit-empty-msg' });
        else {
            const grouped = new Map<string, TFile[]>();
            invalids.forEach(i => i.issues.forEach(iss => { if (!grouped.has(iss)) grouped.set(iss, []); grouped.get(iss)?.push(i.file); }));
            grouped.forEach((fls, iss) => {
                const row = box.createDiv({ cls: 'btm-audit-item btm-clickable-row' });
                row.createSpan({ text: iss, cls: 'btm-audit-issue-text' }); row.createSpan({ text: ` (${fls.length} notes)`, cls: 'btm-audit-count-badge' });
                row.onclick = () => { this.close(); if (fls.length === 1) this.app.workspace.getLeaf(false).openFile(fls[0]); else new SimpleFileListModal(this.app, 'Affected Notes', fls).open(); };
            });
        }
    }

    createIconButton(cont: HTMLElement, icon: string, text: string, cls: string = '') {
        const b = cont.createEl('button', { cls: `btm-icon-btn ${cls}`.trim() }); setIcon(b.createSpan(), icon); b.createSpan({ text: ' ' + text }); return b;
    }

    createProgressBar(cont: HTMLElement, val: number) {
        const bar = cont.createDiv({ cls: 'btm-progress-bar-mini' }); const fill = bar.createDiv({ cls: 'btm-progress-fill-mini' });
        fill.style.width = `${val}%`; fill.addClass(val < 50 ? 'btm-progress-low' : val < 80 ? 'btm-progress-medium' : 'btm-progress-high');
    }
}

class SimpleFileListModal extends Modal {
    constructor(app: App, private title: string, private files: TFile[]) { super(app); }
    onOpen() {
        const { contentEl } = this; contentEl.empty(); new Setting(contentEl).setName(this.title).setHeading();
        const list = contentEl.createDiv({ cls: 'btm-file-list' });
        this.files.forEach(f => {
            const item = list.createDiv({ cls: 'btm-file-item btm-clickable-row', text: f.path });
            item.onclick = () => { this.close(); this.app.workspace.getLeaf(false).openFile(f); };
        });
    }
}

class TagListModal extends Modal {
    constructor(app: App, private title: string, private tags: string[]) { super(app); }
    onOpen() {
        const { contentEl } = this; contentEl.empty(); new Setting(contentEl).setName(this.title).setHeading();
        const list = contentEl.createDiv({ cls: 'btm-tag-list-simple' });
        this.tags.forEach(t => { list.createSpan({ cls: 'btm-tag-pill', text: '#' + t }); });
    }
}

class TagHierarchyModal extends Modal {
    constructor(app: App, private plugin: TagLowercasePlugin) { super(app); }
    onOpen() {
        const { contentEl } = this; contentEl.empty(); new Setting(contentEl).setName('Tag Hierarchy').setHeading();
        const tree = contentEl.createDiv({ cls: 'btm-tree' });
        this.renderNodes(tree, this.plugin.getTagHierarchy(), 0);
    }
    renderNodes(cont: HTMLElement, nodes: TagNode[], d: number) {
        nodes.sort((a,b)=>a.name.localeCompare(b.name)).forEach(n => {
            const item = cont.createDiv({ cls: 'btm-tree-node' }); item.style.paddingLeft = `${d*20}px`;
            const h = item.createDiv({ cls: 'btm-tree-header' }); setIcon(h.createSpan(), n.children.length>0?'folder':'tag');
            h.createSpan({ text: n.name + (n.count>0?` (${n.count})`:'') });
            if (n.children.length > 0) this.renderNodes(cont, n.children, d+1);
        });
    }
}

class OrphanTagsModal extends Modal {
    constructor(app: App, private plugin: TagLowercasePlugin) { super(app); }
    onOpen() {
        const { contentEl } = this; contentEl.empty(); new Setting(contentEl).setName('Orphan Tags').setHeading();
        const orphans = this.plugin.findOrphanedTags();
        if (orphans.length === 0) contentEl.createEl('p', { text: 'No orphans found.' });
        else {
            const list = contentEl.createDiv({ cls: 'btm-tag-grid' });
            orphans.forEach(o => { const s = list.createSpan({ cls: 'btm-tag-pill-orphan' }); s.createSpan({ text: o.tag }); s.createSpan({ text: ` ${o.count}`, cls: 'btm-count' }); });
        }
    }
}

class HistoryModal extends Modal {
    constructor(app: App, private plugin: TagLowercasePlugin) { super(app); }
    onOpen() {
        const { contentEl } = this; contentEl.empty(); new Setting(contentEl).setName('History').setHeading();
        this.plugin.settings.operationHistory.forEach((op, i) => {
            const item = contentEl.createDiv({ cls: 'btm-history-item' });
            item.createDiv({ text: op.description, cls: 'btm-history-desc' });
            item.createDiv({ text: new Date(op.timestamp).toLocaleString(), cls: 'btm-history-time' });
            if (i === 0) { const b = item.createEl('button', { text: 'Undo' }); b.onclick = () => { this.close(); this.plugin.undoLastOperation(); }; }
        });
    }
}

class MultiTagSelectModal extends Modal {
    sel: Set<string> = new Set();
    constructor(app: App, private plugin: TagLowercasePlugin, private onC: (t: string[]) => void) { super(app); }
    onOpen() {
        const { contentEl } = this; contentEl.empty(); new Setting(contentEl).setName('Select Tags').setHeading();
        const list = contentEl.createDiv({ cls: 'btm-tag-grid-select' });
        this.plugin.getAllTags().forEach(t => {
            const p = list.createSpan({ cls: 'btm-tag-pill-select', text: '#' + t });
            p.onclick = () => { p.classList.toggle('is-selected'); if (this.sel.has(t)) this.sel.delete(t); else this.sel.add(t); };
        });
        const b = contentEl.createEl('button', { text: 'Confirm', cls: 'mod-cta' });
        b.onclick = () => { this.close(); this.onC(Array.from(this.sel)); };
    }
}

class TagSuggest extends SuggestModal<string> {
    constructor(app: App, private plugin: TagLowercasePlugin, private onS: (t: string) => void) { super(app); }
    getSuggestions(q: string) { return this.plugin.getAllTags().filter(t => t.toLowerCase().includes(q.toLowerCase())); }
    renderSuggestion(t: string, el: HTMLElement) { el.createSpan({ text: '#' + t }); }
    onChooseSuggestion(t: string) { this.onS(t); }
}

class TagLowercaseSettingTab extends PluginSettingTab {
    constructor(app: App, private plugin: TagLowercasePlugin) { super(app, plugin); }
    display() {
        const { containerEl } = this; containerEl.empty(); new Setting(containerEl).setName('Settings').setHeading();
        new Setting(containerEl).setName('Case Strategy').addDropdown(d => d.addOption('lowercase', 'Lower').addOption('uppercase', 'Upper').addOption('none', 'None').setValue(this.plugin.settings.caseStrategy).onChange(async v => { this.plugin.settings.caseStrategy = v as any; await this.plugin.saveSettings(); }));
        new Setting(containerEl).setName('Separator').addDropdown(d => d.addOption('preserve', 'Presere').addOption('snake', 'Snake').addOption('kebab', 'Kebab').setValue(this.plugin.settings.separatorStrategy).onChange(async v => { this.plugin.settings.separatorStrategy = v as any; await this.plugin.saveSettings(); }));
        new Setting(containerEl).setName('Remove Special').addToggle(t => t.setValue(this.plugin.settings.removeSpecialChars).onChange(async v => { this.plugin.settings.removeSpecialChars = v; await this.plugin.saveSettings(); }));
    }
}

class ProgressModal extends Modal {
    private bar: HTMLElement; private text: HTMLElement;
    constructor(app: App, private total: number) { super(app); }
    onOpen() {
        const { contentEl } = this; contentEl.empty(); contentEl.addClass('btm-progress-modal');
        new Setting(contentEl).setName('Processing...').setHeading();
        const cont = contentEl.createDiv({ cls: 'btm-progress-container' });
        const pBar = cont.createDiv({ cls: 'btm-progress-bar' }); this.bar = pBar.createDiv({ cls: 'btm-progress-fill' });
        this.text = contentEl.createDiv({ cls: 'btm-progress-text', text: `0 / ${this.total}` });
    }
    update(cur: number) {
        const pct = Math.round((cur / this.total) * 100);
        if (this.bar) this.bar.style.width = `${pct}%`;
        if (this.text) this.text.textContent = `${cur} / ${this.total} (${pct}%)`;
    }
}

class PreviewModal extends Modal {
    constructor(app: App, private plugin: TagLowercasePlugin, private preview: PreviewResult, private onC: (f: PreviewFile[]) => void) { super(app); }
    onOpen() {
        const { contentEl } = this; contentEl.empty(); contentEl.addClass('btm-preview-modal');
        new Setting(contentEl).setName('Preview Changes').setHeading();
        contentEl.createEl('p', { text: `${this.preview.affectedFiles.length} files affected.` });
        const list = contentEl.createDiv({ cls: 'btm-preview-list' });
        this.preview.affectedFiles.forEach(f => {
            const item = list.createDiv({ cls: 'btm-preview-file' });
            item.createDiv({ text: f.path, cls: 'btm-preview-file-path' });
            const changes = item.createDiv({ cls: 'btm-preview-changes' });
            f.changes.slice(0, 3).forEach(c => {
                changes.createDiv({ text: `L${c.line}: - ${c.before}`, cls: 'btm-diff-remove' });
                changes.createDiv({ text: `L${c.line}: + ${c.after}`, cls: 'btm-diff-add' });
            });
        });
        const btns = contentEl.createDiv({ cls: 'btm-button-row' });
        const can = btns.createEl('button', { text: 'Cancel' }); can.onclick = () => this.close();
        const ok = btns.createEl('button', { text: 'Apply', cls: 'mod-cta' }); ok.onclick = () => { this.close(); this.onC(this.preview.affectedFiles); };
    }
}

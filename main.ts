import { App, Component, DropdownComponent, Keymap, Menu, Modal, Notice, Plugin, PluginSettingTab, Setting, SuggestModal, TFile, TFolder, TextComponent, parseFrontMatterAliases, setIcon, setTooltip } from 'obsidian';

// --- Interfaces ---

interface OperationRecord {
    id: string;
    timestamp: number;
    type: string;
    description: string;
    changes: { path: string; before?: string; after?: string }[];
    useExternalStorage?: boolean;
    useExternalManifest?: boolean;
    nonRevertible?: boolean;
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
    wikiLinkStats: {
        yamlList: TFile[];
        inlineArray: TFile[];
    };
    inlineFiles: { file: TFile; count: number; tags: string[] }[];
    nestedFiles: { file: TFile; count: number; tags: string[] }[];
    quotedFrontmatterCount: number;
    quotedFrontmatterFiles: TFile[];
    caseDuplicates: { canonical: string, variants: string[] }[];
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
    wikiLinkFormat: 'inline' | 'list';
    aliases: Record<string, string>;
    operationHistory: OperationRecord[];
    scopeFilter: ScopeFilter;
    orphanThreshold: number;
    maxHistorySize: number;
    historyExpirationDays: number;
    ignoredIssues: string[];
    protectedTags: string[];
}

const DEFAULT_SETTINGS: TagLowercaseSettings = {
    caseStrategy: 'lowercase',
    separatorStrategy: 'preserve',
    removeSpecialChars: false,
    flattenDiacritics: false,
    applyToNestedTags: true,
    tagFormat: 'inline',
    wikiLinkFormat: 'inline',
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
    ignoredIssues: [],
    protectedTags: []
};

// Improved regex that skips code blocks
const TAG_REGEX = /(^|\s)(#[\p{L}\p{N}_/-]+)/gu;
const TAG_HOVER_SOURCE = 'bulk-tag-manager:tag-pane';

interface TagPageFileSet extends Set<TFile> {
    tag?: string;
}

interface TagMenuContext {
    isHierarchy?: boolean;
}

interface TagInteractionOptions {
    selector: string;
    container: string;
    hoverSource: string;
    toTag: (el: HTMLElement) => string | null;
    mergeMenu?: boolean;
    enableContextMenu?: boolean;
}

type TagHierarchySortStrategy = 'alphabetical' | 'nesting' | 'usage';

type GlobalSearchInstance = {
    openGlobalSearch?: (query: string) => void;
    getGlobalSearchQuery?: () => string;
};

type InternalPlugins = {
    getPluginById?: (id: string) => { instance?: unknown } | undefined;
};

type DragManager = {
    draggable?: {
        source?: string;
        title?: string;
    };
    onDragStart?: (
        event: DragEvent,
        data: { source: string; type: string; title: string; icon: string },
    ) => void;
    updateHover?: (targetEl: HTMLElement, cls: string) => void;
    setAction?: (action: string) => void;
};

function isRecord(value: unknown): value is Record<string, unknown> {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function getGlobalSearch(app: App): GlobalSearchInstance | undefined {
    const internalPlugins = (app as App & { internalPlugins?: InternalPlugins }).internalPlugins;
    const instance = internalPlugins?.getPluginById?.('global-search')?.instance;
    if (!instance) return undefined;
    if (!isRecord(instance)) return undefined;
    return instance as GlobalSearchInstance;
}

function getDragManager(app: App): DragManager | undefined {
    const dragManager = (app as App & { dragManager?: unknown }).dragManager;
    if (!dragManager) return undefined;
    if (!isRecord(dragManager)) return undefined;
    return dragManager as DragManager;
}

function runAsync(task: () => Promise<unknown>): void {
    void task().catch((err) => console.error('[Bulk Tag Manager]', err));
}

function registerDelegatedDomEvent(
    component: Component,
    target: Document | Window | HTMLElement,
    eventName: string,
    selector: string,
    handler: (event: Event, targetEl: HTMLElement) => void,
    options?: AddEventListenerOptions | boolean,
) {
    const listener = (event: Event) => {
        const rawTarget = event.target;
        if (!rawTarget) return;

        const targetNode = rawTarget as unknown as Node;
        if (!targetNode.instanceOf(Element)) return;

        const closest = (rawTarget as Element).closest(selector);
        if (!closest) return;

        const closestNode = closest as unknown as Node;
        if (!closestNode.instanceOf(HTMLElement)) return;

        handler(event, closest as HTMLElement);
    };
    target.addEventListener(eventName, listener, options);
    component.register(() => target.removeEventListener(eventName, listener, options));
}

function menuForEvent(event: MouseEvent): Menu {
    const menuFactory = Menu as typeof Menu & { forEvent?: (event: MouseEvent) => Menu };
    if (menuFactory.forEvent) {
        return menuFactory.forEvent(event);
    }

    const cached = (event as MouseEvent & { obsidian_contextmenu?: Menu }).obsidian_contextmenu;
    if (cached) return cached;

    const menu = new Menu();
    (event as MouseEvent & { obsidian_contextmenu?: Menu }).obsidian_contextmenu = menu;
    window.setTimeout(() => menu.showAtPosition({ x: event.pageX, y: event.pageY }), 0);
    return menu;
}

function parseCsvRenamePairs(csvText: string): { from: string; to: string }[] {
    const lines = csvText
        .split(/\r?\n/)
        .map(l => l.trim())
        .filter(l => l && !l.startsWith('#'));

    const pairs: { from: string; to: string }[] = [];

    for (const line of lines) {
        const commaIdx = line.indexOf(',');
        if (commaIdx === -1) continue;

        const from = line.substring(0, commaIdx).trim().replace(/^#/, '');
        const to = line.substring(commaIdx + 1).trim().replace(/^#/, '');

        // Skip header row
        if (from === 'old_tag' && to === 'new_tag') continue;
        if (!from || !to) continue;

        pairs.push({ from, to });
    }

    return pairs;
}

function parseTagDeleteList(text: string): string[] {
    return text
        .split(/\r?\n/)
        .map(l => l.trim().replace(/^#/, ''))
        .filter(l => l && !l.startsWith('#') && !l.startsWith('//'));
}


class InlineTagSuggest {
    private suggestEl: HTMLElement;
    private isOpen = false;
    
    constructor(private app: App, private inputEl: HTMLInputElement, private containerEl: HTMLElement, private onSelect: (tag: string) => void) {
        this.suggestEl = containerEl.createDiv({ cls: 'btm-inline-suggestions' });
        this.suggestEl.hide();
        
        inputEl.addEventListener('input', () => this.updateSuggestions());
        inputEl.addEventListener('blur', () => {
            // Delay to allow clicking on an item
            window.setTimeout(() => this.hide(), 200);
        });
        inputEl.addEventListener('keydown', (e) => {
            if (e.key === 'Escape') this.hide();
        });
    }

    private hide() {
        this.suggestEl.hide();
        this.isOpen = false;
    }

    private show() {
        this.suggestEl.show();
        this.isOpen = true;
    }

    updateSuggestions() {
        const query = this.inputEl.value.toLowerCase().replace(/^#/, '');
        if (!query) { this.hide(); return; }

        const allTags = Object.keys(this.app.metadataCache.getTags() ?? {}).map(t => t.replace(/^#/, ''));
        const matches = allTags.filter(t => t.toLowerCase().includes(query)).slice(0, 8);

        if (matches.length > 0) {
            this.suggestEl.empty();
            matches.forEach(m => {
                const item = this.suggestEl.createDiv({ text: '#' + m, cls: 'btm-suggest-item' });
                item.onclick = () => {
                    this.inputEl.value = m;
                    this.onSelect(m);
                    this.hide();
                };
            });
            this.show();
        } else {
            this.hide();
        }
    }
}

export default class TagLowercasePlugin extends Plugin {
    settings: TagLowercaseSettings;
    pageAliases: Map<TFile, string[]> = new Map();
    tagPages: Map<string, TagPageFileSet> = new Map();
    settingsTab: TagLowercaseSettingTab;

    async onload() {
        await this.loadSettings();
        await this.purgeExpiredHistory();



        this.addCommand({
            id: 'open-tag-manager',
            name: 'Open settings',
            callback: () => this.openPluginSettings()
        });

        this.addCommand({
            id: 'open-tag-manager-modal',
            name: 'Open dashboard (modal)',
            callback: () => new TagManagerModal(this.app, this).open(),
        });

        this.addCommand({
            id: 'convert-all-tags',
            name: 'Convert all tags (with preview)',
            callback: async () => {
                await this.loadSettings(); // Reload settings before running
                await this.runConversionWithPreview();
            }
        });

        this.addCommand({
            id: 'generate-tag-list',
            name: 'Generate Tag List',
            callback: () => {
                void this.generateTagList();
            }
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
            callback: () => {
                void this.undoLastOperation();
            }
        });

        this.settingsTab = new TagLowercaseSettingTab(this.app, this);
        this.addSettingTab(this.settingsTab);
        this.registerTagWranglerFeatures();

        // Register event for alias auto-correction
        this.registerEvent(
            this.app.vault.on('modify', (file) => {
                if (this.isBulkOperationInProgress) return;
                if (file instanceof TFile && file.extension === 'md' && Object.keys(this.settings.aliases).length > 0) {
                    this.applyAliasesDebounced(file);
                }
            })
        );
    }

    onunload() {
        for (const timer of this.aliasDebounceTimers.values()) {
            window.clearTimeout(timer);
        }
        this.aliasDebounceTimers.clear();
    }

    private aliasDebounceTimers: Map<string, ReturnType<Window['setTimeout']>> = new Map();
    private isBulkOperationInProgress = false;

    openPluginSettings() {
        const settings = (this.app as App & { setting?: { open: () => void; openTabById?: (id: string) => void } }).setting;
        settings?.open();
        settings?.openTabById?.(this.manifest.id);
    }

    isTagProtected(tag: string): boolean {
        const cleanTag = tag.replace(/^#/, '');
        return this.settings.protectedTags.some(p => {
            const cleanP = p.replace(/^#/, '');
            if (cleanP === cleanTag) return true;
            if (cleanP.endsWith('*')) {
                const prefix = cleanP.slice(0, -1);
                return cleanTag.startsWith(prefix);
            }
            return false;
        });
    }

    applyAliasesDebounced(file: TFile) {
        const existingTimer = this.aliasDebounceTimers.get(file.path);
        if (existingTimer) window.clearTimeout(existingTimer);
        
        const timer = window.setTimeout(() => {
            void this.applyAliases(file);
            this.aliasDebounceTimers.delete(file.path);
        }, 1000);
        
        this.aliasDebounceTimers.set(file.path, timer);
    }

    async loadSettings() {
        const loadedRaw: unknown = await this.loadData();
        const loaded = isRecord(loadedRaw) ? (loadedRaw as Partial<TagLowercaseSettings>) : {};
        const loadedScopeFilter = isRecord(loaded.scopeFilter) ? (loaded.scopeFilter as Partial<ScopeFilter>) : {};
        const loadedAliases = isRecord(loaded.aliases) ? (loaded.aliases as Record<string, string>) : {};

        this.settings = {
            ...DEFAULT_SETTINGS,
            ...loaded,
            scopeFilter: { 
                ...DEFAULT_SETTINGS.scopeFilter, 
                ...loadedScopeFilter,
            },
            aliases: {
                ...DEFAULT_SETTINGS.aliases,
                ...loadedAliases,
            }
        };
    }

    async saveSettings() {
        await this.saveData(this.settings);
    }

    registerTagWranglerFeatures() {
        this.registerEvent(
            this.app.workspace.on('editor-menu', (menu, editor) => {
                const editorWithClickableToken = editor as unknown as {
                    getCursor: () => unknown;
                    getClickableTokenAt?: (cursor: unknown) => unknown;
                };

                const token = editorWithClickableToken.getClickableTokenAt?.(editorWithClickableToken.getCursor());
                if (!isRecord(token) || token.type !== 'tag' || typeof token.text !== 'string') return;
                this.setupTagWranglerMenu(menu, token.text);
            }),
        );

        registerDelegatedDomEvent(this, activeDocument, 'contextmenu', '.tag-pane-tag', (event, targetEl) => {
            const mouseEvent = event as MouseEvent;
            const tagText = targetEl.querySelector('.tag-pane-tag-text, .tree-item-inner-text')?.textContent?.trim();
            if (!tagText) return;

            const isHierarchy = !!targetEl.parentElement?.parentElement?.querySelector('.collapse-icon');
            this.setupTagWranglerMenu(menuForEvent(mouseEvent), tagText, { isHierarchy });
        }, { capture: true });

        registerDelegatedDomEvent(this, activeDocument, 'pointerdown', '.tag-pane-tag', (_, targetEl) => {
            targetEl.draggable = true;
        }, { capture: true });

        registerDelegatedDomEvent(this, activeDocument, 'dragstart', '.tag-pane-tag', (event, targetEl) => {
            const dragEvent = event as DragEvent;
            const tagText = targetEl.querySelector('.tag-pane-tag-text, .tree-item-inner-text')?.textContent?.trim();
            if (!dragEvent.dataTransfer || !tagText) return;
            const dragManager = getDragManager(this.app);

            dragEvent.dataTransfer.setData('text/plain', '#' + tagText);
            dragManager?.onDragStart?.(dragEvent, {
                source: 'bulk-tag-manager',
                type: 'text',
                title: tagText,
                icon: 'hashtag',
            });
        });

        const dropHandler = (event: Event, targetEl: HTMLElement, drop = false) => {
            const dragEvent = event as DragEvent;
            const dragManager = getDragManager(this.app);
            const info = dragManager?.draggable;
            if (!dragEvent.dataTransfer || info?.source !== 'bulk-tag-manager' || dragEvent.defaultPrevented) return;

            const parentTag = targetEl.querySelector('.tag-pane-tag-text, .tree-item-inner-text')?.textContent?.trim();
            if (!parentTag || parentTag.toLowerCase() === String(info.title).toLowerCase()) return;

            dragEvent.dataTransfer.dropEffect = 'move';
            dragEvent.preventDefault();

            const destination = `${parentTag}/${String(info.title).split('/').pop()}`;
            if (drop) {
                void this.renameTag(info.title, destination);
                return;
            }

            dragManager?.updateHover?.(targetEl, 'is-being-dragged-over');
            dragManager?.setAction?.(`Rename to ${destination}`);
        };

        registerDelegatedDomEvent(this, activeDocument.body, 'dragover', '.tag-pane-tag.tree-item-self', (event, targetEl) => {
            dropHandler(event, targetEl);
        }, { capture: true });

        registerDelegatedDomEvent(this, activeDocument.body, 'dragenter', '.tag-pane-tag.tree-item-self', (event, targetEl) => {
            dropHandler(event, targetEl);
        }, { capture: true });

        this.registerDomEvent(activeWindow, 'drop', (event) => {
            const rawTarget = event.target;
            if (!rawTarget) return;

            const targetNode = rawTarget as unknown as Node;
            if (!targetNode.instanceOf(Element)) return;

            const closest = (rawTarget as Element).closest('.tag-pane-tag.tree-item-self');
            if (!closest) return;

            const closestNode = closest as unknown as Node;
            if (!closestNode.instanceOf(HTMLElement)) return;

            dropHandler(event, closest as HTMLElement, true);
        }, { capture: true });

        const workspaceWithHoverSources = this.app.workspace as unknown as {
            registerHoverLinkSource?: (sourceId: string, options: { display: string; defaultMod?: boolean }) => void;
        };
        workspaceWithHoverSources.registerHoverLinkSource?.(TAG_HOVER_SOURCE, { display: 'Tags View', defaultMod: true });

        this.addChild(new TagInteractionHandler(this, {
            hoverSource: TAG_HOVER_SOURCE,
            selector: '.tag-pane-tag',
            container: '.tag-container',
            toTag: (el) => el.querySelector('.tag-pane-tag-text, .tree-item-inner-text')?.textContent?.trim() ?? null,
            enableContextMenu: false,
        }));

        this.addChild(new TagInteractionHandler(this, {
            hoverSource: 'preview',
            selector: 'a.tag[href^="#"]',
            container: '.markdown-preview-view, .markdown-embed, .workspace-leaf-content',
            toTag: (el) => el.getAttribute('href'),
            enableContextMenu: true,
        }));

        this.addChild(new TagInteractionHandler(this, {
            hoverSource: 'preview',
            selector: '.metadata-property[data-property-key="tags"] .multi-select-pill',
            container: '.metadata-properties',
            toTag: (el) => el.textContent?.trim() ?? null,
            mergeMenu: true,
            enableContextMenu: true,
        }));

        this.addChild(new TagInteractionHandler(this, {
            hoverSource: 'editor',
            selector: 'span.cm-hashtag',
            container: '.markdown-source-view',
            toTag: (el) => {
                if (el.classList.contains('cm-formatting')) return null;
                let tagName = el.textContent ?? '';
                for (let previous = el.previousElementSibling; previous?.matches('span.cm-hashtag:not(.cm-formatting)'); previous = previous.previousElementSibling) {
                    tagName = `${previous.textContent ?? ''}${tagName}`;
                }
                for (let next = el.nextElementSibling; next?.matches('span.cm-hashtag:not(.cm-formatting)'); next = next.nextElementSibling) {
                    tagName += next.textContent ?? '';
                }
                return tagName || null;
            },
            enableContextMenu: false,
        }));

        const rebuildTagPages = () => {
            this.pageAliases.clear();
            this.tagPages.clear();

            for (const path of this.app.metadataCache.getCachedFiles()) {
                const file = this.app.vault.getAbstractFileByPath(path);
                if (file instanceof TFile) {
                    this.updateTagPage(file, this.app.metadataCache.getCache(path)?.frontmatter);
                }
            }
        };

        this.app.workspace.onLayoutReady(() => {
            rebuildTagPages();

            this.registerEvent(
                this.app.metadataCache.on('changed', (file, _data, cache) => {
                    this.updateTagPage(file, cache?.frontmatter);
                }),
            );

            this.registerEvent(
                this.app.vault.on('delete', (file) => {
                    if (file instanceof TFile) {
                        this.updateTagPage(file);
                    }
                }),
            );
        });
    }

    tagPage(tag: string): TFile | undefined {
        return Array.from(this.tagPages.get(this.canonicalTag(tag)) ?? [])[0];
    }

    canonicalTag(tag: string): string {
        return `#${tag.replace(/^#/, '').toLowerCase()}`;
    }

    async openTagPage(file: TFile, isNew: boolean, newLeaf: boolean) {
        const openState = {
            eState: isNew ? { rename: 'all' } : { focus: true },
            ...(isNew ? { state: { mode: 'source' } } : {}),
        };
        await this.app.workspace.getLeaf(newLeaf).openFile(file, openState);
    }

    async createTagPage(tagName: string, newLeaf = false) {
        const cleanTag = tagName.replace(/^#/, '');
        const eventPayload: { tag: string; file?: TFile | Promise<TFile> } = { tag: `#${cleanTag}` };
        this.app.workspace.trigger('tag-page:will-create', eventPayload);

        let file = eventPayload.file ? await eventPayload.file : undefined;
        if (!file) {
            const baseName = cleanTag.split('/').join(' ');
            const folder = this.app.fileManager.getNewFileParent(this.app.workspace.getActiveFile()?.path ?? '');
            const folderPrefix = folder.path ? `${folder.path}/` : '';
            const vaultWithAvailablePath = this.app.vault as unknown as {
                getAvailablePath?: (path: string, extension: string) => string;
            };
            const path = vaultWithAvailablePath.getAvailablePath
                ? vaultWithAvailablePath.getAvailablePath(`${folderPrefix}${baseName}`, 'md')
                : `${folderPrefix}${baseName}.md`;
            file = await this.app.vault.create(path, [
                '---',
                `Aliases: [ ${JSON.stringify('#' + cleanTag)} ]`,
                '---',
                '',
            ].join('\n'));
        }

        eventPayload.file = file;
        await this.openTagPage(file, true, newLeaf);
        this.app.workspace.trigger('tag-page:did-create', eventPayload);
    }

    updateTagPage(file: TFile, frontmatter?: Record<string, unknown>) {
        const tags = (parseFrontMatterAliases(frontmatter)?.filter((alias) => /^#[^\s]+$/.test(alias)) ?? [])
            .map((alias) => alias.replace(/^##+/, '#'));

        const previousTags = this.pageAliases.get(file) ?? [];
        if (previousTags.length) {
            const retained = new Set(tags);
            for (const tag of previousTags) {
                if (retained.has(tag)) continue;
                const existing = this.tagPages.get(this.canonicalTag(tag));
                if (!existing) continue;
                existing.delete(file);
                if (!existing.size) {
                    this.tagPages.delete(this.canonicalTag(tag));
                }
            }
        }

        if (!tags.length) {
            this.pageAliases.delete(file);
            return;
        }

        this.pageAliases.set(file, tags);
        for (const tag of tags) {
            const key = this.canonicalTag(tag);
            const tagSet = this.tagPages.get(key) ?? Object.assign(new Set<TFile>(), { tag }) as TagPageFileSet;
            tagSet.add(file);
            tagSet.tag = `#${tag.replace(/^#/, '')}`;
            this.tagPages.set(key, tagSet);
        }
    }

    async openRandomTaggedNote(tagName: string) {
        const cleanTag = tagName.replace(/^#/, '');
        const files = this.getFilteredFiles().filter((file) => {
            const cache = this.app.metadataCache.getFileCache(file);
            const inlineMatches = (cache?.tags ?? []).some((tag) => {
                const raw = tag.tag.replace(/^#/, '').toLowerCase();
                return raw === cleanTag.toLowerCase() || raw.startsWith(`${cleanTag.toLowerCase()}/`);
            });
            const frontmatterTags = [
                ...this.extractFrontmatterTags(cache?.frontmatter?.tags),
                ...this.extractFrontmatterTags(cache?.frontmatter?.tag),
            ];
            const frontmatterMatches = frontmatterTags.some((tag) => {
                    const raw = tag.replace(/^#/, '').toLowerCase();
                    return raw === cleanTag.toLowerCase() || raw.startsWith(`${cleanTag.toLowerCase()}/`);
                });

            return inlineMatches || frontmatterMatches;
        });

        if (!files.length) {
            new Notice(`No notes found for #${cleanTag}.`);
            return;
        }

        const file = files[Math.floor(Math.random() * files.length)];
        await this.app.workspace.getLeaf(true).openFile(file);
    }

    confirmDeleteTag(tagName: string) {
        const cleanTag = tagName.replace(/^#/, '');
        new BtmConfirmationModal(
            this.app,
            'Delete Tag',
            `Delete #${cleanTag} and any child tags in the current scope?`,
            async () => {
                await this.deleteTags([cleanTag]);
            },
        ).open();
    }

    setupTagWranglerMenu(menu: Menu, tagName: string, context: TagMenuContext = {}) {
        const cleanTag = tagName.replace(/^#/, '');
        const tagPage = this.tagPage(cleanTag);
        const search = getGlobalSearch(this.app);
        const query = search?.getGlobalSearchQuery?.() ?? '';
        const smartRandom = (this.app as App & { plugins?: { plugins?: Record<string, unknown> } }).plugins?.plugins?.['smart-random-note'];

        menu.addItem((item) => item.setIcon('pencil').setTitle(`Rename #${cleanTag}`).onClick(() => {
            new TagRenamePromptModal(this.app, this, cleanTag).open();
        }));
        menu.addItem((item) => item.setIcon('trash').setTitle(`Delete #${cleanTag}`).onClick(() => {
            this.confirmDeleteTag(cleanTag);
        }));

        if (tagPage) {
            menu.addItem((item) => item.setIcon('popup-open').setTitle('Open tag page').onClick((event) => {
                void this.openTagPage(tagPage, false, !!Keymap.isModEvent(event));
            }));
        } else {
            menu.addItem((item) => item.setIcon('create-new').setTitle('Create tag page').onClick((event) => {
                void this.createTagPage(cleanTag, !!Keymap.isModEvent(event));
            }));
        }

        if (search?.openGlobalSearch) {
            menu.addItem((item) => item.setIcon('magnifying-glass').setTitle(`New search for #${cleanTag}`).onClick(() => {
                search.openGlobalSearch(`tag:#${cleanTag}`);
            }));

            if (query) {
                menu.addItem((item) => item.setIcon('sheets-in-box').setTitle(`Require #${cleanTag} in search`).onClick(() => {
                    search.openGlobalSearch(`${query} tag:#${cleanTag}`.trim());
                }));
            }

            menu.addItem((item) => item.setIcon('crossed-star').setTitle(`Exclude #${cleanTag} from search`).onClick(() => {
                search.openGlobalSearch(`${query} -tag:#${cleanTag}`.trim());
            }));
        }

        if (smartRandom) {
            menu.addItem((item) => item.setIcon('dice').setTitle('Open random note').onClick(() => {
                void this.openRandomTaggedNote(cleanTag);
            }));
        }

        this.app.workspace.trigger('tag-wrangler:contextmenu', menu, cleanTag, {
            search,
            query,
            isHierarchy: !!context.isHierarchy,
            tagPage,
        });

        menu.addSeparator();
        menu.addItem((item) => item.setIcon('settings').setTitle('Open settings').onClick(() => {
            this.openPluginSettings();
        }));
    }


    extractFrontmatterTags(value: unknown): string[] {
        if (Array.isArray(value)) {
            return value.filter((item): item is string => typeof item === 'string');
        }
        if (typeof value === 'string') {
            return value
                .split(',')
                .map((tag) => tag.trim())
                .filter(Boolean);
        }
        return [];
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
            const looksComplex =
                filePattern.length > 100 ||
                /([+*?])\1+/.test(filePattern) ||
                /\([^)]*[+*][^)]*\)\+/.test(filePattern);

            if (looksComplex) {
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
            fullRecord.nonRevertible = true;
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

        if (lastOp.nonRevertible) {
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

        this.isBulkOperationInProgress = true;
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
                        beforeContent = change.before ?? '';
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
        this.isBulkOperationInProgress = false;

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
                try {
                    this.isBulkOperationInProgress = true;
                    let attemptCount = 0;
                    const changes: FileChange[] = [];
                    const errors: { path: string; message: string }[] = [];

                    for (const file of files) {
                        attemptCount++;
                        try {
                            const before = await this.app.vault.read(file);
                            await this.app.fileManager.processFrontMatter(file, (fm) => {
                                if (!isRecord(fm)) return;

                                const processValue = (val: unknown): unknown => {
                                    if (typeof val === 'string') return val.trim();
                                    if (Array.isArray(val)) return val.map(v => processValue(v));
                                    
                                    // Recursive walk for nested objects, excluding Dates
                                    if (isRecord(val) && !(val instanceof Date)) {
                                        for (const k in val) val[k] = processValue(val[k]);
                                    }
                                    return val;
                                };

                                for (const key of Object.keys(fm)) {
                                    fm[key] = processValue(fm[key]);
                                }
                            });
                            const after = await this.app.vault.read(file);
                            if (before !== after) {
                                changes.push({ path: file.path, before, after });
                            }
                        } catch (e) {
                            const errorMsg = e instanceof Error ? e.message : String(e);
                            console.error(`Standardise failed for ${file.path}:`, errorMsg);
                            errors.push({ path: file.path, message: errorMsg });
                        }

                        // Throttle: Yield to event loop every 50 files based on attempts
                        if (attemptCount % 50 === 0) {
                            progressModal.update(attemptCount);
                            await new Promise(resolve => window.setTimeout(resolve, 5));
                        } else {
                            progressModal.update(attemptCount);
                        }
                    }

                    if (changes.length > 0) {
                        await this.addToHistory({
                            type: 'standardise-properties',
                            description: `Clean frontmatter formatting (${changes.length} files)`,
                            changes,
                        });
                    }
                    new Notice(`Finished: ${changes.length} files changed. ${errors.length > 0 ? `(${errors.length} skipped due to errors)` : ''}`);
                    
                    if (errors.length > 0) {
                        new BtmErrorReportModal(this.app, this, 'Standardise Errors', errors).open();
                    }
                } finally {
                    this.isBulkOperationInProgress = false;
                    progressModal.close();
                }
            }
        ).open();
    }

    async fixInvalidMappingError(file: TFile): Promise<void> {
        // 1. Read raw text from disk (bypasses parser)
        const before = await this.app.vault.read(file);
        const fmMatch = before.match(/^---\n([\s\S]*?)\n---/);

        if (!fmMatch) return;

        const originalFm = fmMatch[1];
        const lines = originalFm.split('\n');
        let isModified = false;

        const fixedLines = lines.map(line => {
            // Regex targets lines like: Key: Text with a: inside
            // Group 1: The Key (e.g., "Resumen")
            // Group 2: The invalid unquoted value (contains : )
            // Negative lookahead ensures we do not touch already quoted or complex lines.
            const match = line.match(/^([\w\s_-]+):\s*(?!["'[{>|])(.*:\s.*)$/);

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
            const fmStartIdx = before.indexOf('---\n') + 4;
            const fmEndIdx = before.indexOf('\n---', fmStartIdx);
            if (before.indexOf('---\n') === -1 || fmEndIdx === -1) return; // safety check
            const newContent = before.substring(0, fmStartIdx) + newFm + before.substring(fmEndIdx);
            await this.app.vault.modify(file, newContent);
            await this.addToHistory({
                type: 'fix-invalid-mapping',
                description: `Fix invalid frontmatter mapping (${file.path})`,
                changes: [{ path: file.path, before, after: newContent }],
            });
        }
    }

    // --- Preview System ---

    async previewConversion(): Promise<PreviewResult> {
        const files = this.getFilteredFiles();
        const affectedFiles: PreviewFile[] = [];
        for (const file of files) {
            const content = await this.app.vault.read(file);
            const codeBlockRanges = this.getCodeBlockRanges(content);
            const fmMatch = content.match(/^---\n[\s\S]*?\n---/);
            const skipStart = fmMatch ? fmMatch[0].length : 0;
            const newContent = this.transformContent(content, skipStart, codeBlockRanges);
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
                    if (Array.isArray(fm.tags)) fm.tags.forEach((t: unknown) => typeof t === 'string' && checkTag(t));
                    else if (typeof fm.tags === 'string') checkTag(fm.tags);
                }
                if (fm.tag) {
                    if (Array.isArray(fm.tag)) fm.tag.forEach((t: unknown) => typeof t === 'string' && checkTag(t));
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

        this.isBulkOperationInProgress = true;
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
        this.isBulkOperationInProgress = false;

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

        try {
            this.isBulkOperationInProgress = true;
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

            if (changes.length > 0) {
                await this.addToHistory({
                    type: 'convert',
                    description: `Bulk conversion (${changes.length} files)`,
                    changes
                });
            }

            new Notice(`Processed ${processedCount} files.`);
        } finally {
            this.isBulkOperationInProgress = false;
            progressModal.close();
        }
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

        if (this.isTagProtected(search)) {
            new Notice(`⚠️ #${search} is protected and cannot be modified.`);
            return;
        }

        new Notice(`Scanning for #${search}...`);

        const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const escapedSearch = escapeRegExp(search);
        const tagRegex = new RegExp(`(^|\\s)(#)(${escapedSearch}(?:\\/[\\p{L}\\p{N}_\\-]+)*)(?=[\\s]|$|[^\\p{L}\\p{N}_\\/-])`, 'gu');

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

        this.isBulkOperationInProgress = true;
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
                        if (this.isTagProtected(raw)) return t;
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
                            if (newTags.some((t: string, i: number) => t !== fm.tags[i])) {
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
                            if (newTags.some((t: string, i: number) => t !== fm.tag[i])) {
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
                        if (this.isTagProtected(captured)) return m;
                        
                        modified = true;
                        // Handle child tags: #old/child → #new/child
                        if (captured === search) {
                            return prefix + hash + replace;
                        } else if (captured.startsWith(search + '/')) {
                            return prefix + hash + replace + captured.substring(search.length);
                        }
                        return m;
                    });
                    tagRegex.lastIndex = 0; // Reset regex state
                    after = newData;
                    return newData;
                });

                if (modified && before !== after) {
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
        this.isBulkOperationInProgress = false;

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

        const protectedSources = sourcesClean.filter(s => this.isTagProtected(s));
        if (protectedSources.length > 0) {
            new Notice(`⚠️ Protected tags cannot be merged/moved: ${protectedSources.map(s => '#' + s).join(', ')}`);
            return;
        }

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
                cache.tags.forEach(t => tagsInScope.add(
                    (t.tag.startsWith('#') ? t.tag.substring(1) : t.tag).toLowerCase()
                ));
            }
            if (cache?.frontmatter) {
                const extract = (val: unknown) => {
                    if (typeof val === 'string') {
                        val.split(',').forEach((v: string) => {
                            const clean = v.trim().startsWith('#') ? v.trim().substring(1) : v.trim();
                            if (clean) tagsInScope.add(clean.toLowerCase());
                        });
                    } else if (Array.isArray(val)) {
                        val.forEach((v: unknown) => {
                            if (typeof v === 'string') {
                                const clean = v.startsWith('#') ? v.substring(1) : v;
                                tagsInScope.add(clean.toLowerCase());
                            }
                        });
                    }
                };
                if (cache.frontmatter.tags) extract(cache.frontmatter.tags);
                if (cache.frontmatter.tag) extract(cache.frontmatter.tag);
            }
        }

        const missingTags: string[] = [];
        for (const s of sourcesClean) {
            if (!tagsInScope.has(s.toLowerCase())) {
                missingTags.push('#' + s);
            }
        }

        if (missingTags.length > 0) {
            new Notice(`Merge aborted: ${missingTags.join(', ')} not found in current scope. Check for typos or scope filters.`);
            return;
        }

        new Notice(`Merging ${sourcesClean.length} tags into #${targetClean}...`);

        this.isBulkOperationInProgress = true;
        const progressModal = new ProgressModal(this.app, files.length);
        progressModal.open();

        let processedCount = 0;

        // Build regex that matches any of the source tags
        const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const sourcePatterns = sourcesClean.map(s => escapeRegExp(s)).join('|');
        const tagRegex = new RegExp(`(^|\\s)(#)((?:${sourcePatterns})(?:\\/[\\p{L}\\p{N}_\\-]+)*)(?=[\\s]|$|[^\\p{L}\\p{N}_\\/-])`, 'gu');

        for (const file of files) {
            tagRegex.lastIndex = 0; // L05: Reset regex state at loop start
            try {
                const before = await this.app.vault.read(file);
                let modified = false;

                // Process frontmatter tags
                await this.app.fileManager.processFrontMatter(file, (fm) => {
                    const processSingleTag = (t: string): string => {
                        if (typeof t !== 'string') return t;
                        const hasHash = t.startsWith('#');
                        const raw = hasHash ? t.substring(1) : t;
                        if (this.isTagProtected(raw)) return t;

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
                                
                                if (uniqueTags.length !== fm[key].length || uniqueTags.some((t: string, i: number) => t !== fm[key][i])) {
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
                        if (this.isTagProtected(capturedTag)) return match;

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

                if (modified && before !== after) {
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
        this.isBulkOperationInProgress = false;

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

    async nestTags(parent: string, children: string[]): Promise<void> {
        const parentClean = parent.replace(/^#/, '').replace(/^\/+|\/+$/g, '').trim();
        if (!parentClean) {
            new Notice('Please provide a parent tag.');
            return;
        }

        // Validate parent tag name (no spaces, valid chars)
        if (!/^[\p{L}\p{N}_/-]+$/u.test(parentClean)) {
            new Notice(`Invalid parent tag name: #${parentClean}`);
            return;
        }

        const childrenClean = children
            .map(c => c.replace(/^#/, '').trim())
            .filter(c => c && c !== parentClean);

        if (childrenClean.length === 0) {
            new Notice('No valid child tags to nest.');
            return;
        }

        const protectedChildren = childrenClean.filter(c => this.isTagProtected(c));
        if (protectedChildren.length > 0) {
            new Notice(`⚠️ Protected tags cannot be nested: ${protectedChildren.map(c => '#' + c).join(', ')}`);
            return;
        }

        // Filter out tags already nested under the parent
        const alreadyNested = childrenClean.filter(c => c.startsWith(parentClean + '/'));
        const toNest = childrenClean.filter(c => !c.startsWith(parentClean + '/'));

        if (alreadyNested.length > 0) {
            new Notice(`Skipping ${alreadyNested.length} tag(s) already under #${parentClean}.`);
        }

        if (toNest.length === 0) {
            new Notice('All selected tags are already nested under that parent.');
            return;
        }

        // Build the rename map: child → parent/child
        const renameMap = new Map<string, string>();
        for (const child of toNest) {
            renameMap.set(child, `${parentClean}/${child}`);
        }

        // Validate: every child tag must exist in scope
        const files = this.getFilteredFiles();
        const tagsInScope = new Set<string>();
        for (const file of files) {
            const cache = this.app.metadataCache.getFileCache(file);
            if (cache?.tags) {
                cache.tags.forEach(t => tagsInScope.add(
                    (t.tag.startsWith('#') ? t.tag.substring(1) : t.tag).toLowerCase()
                ));
            }
            if (cache?.frontmatter) {
                const extract = (val: unknown) => {
                    if (typeof val === 'string') {
                        val.split(',').forEach((v: string) => {
                            const clean = v.trim().startsWith('#') ? v.trim().substring(1) : v.trim();
                            if (clean) tagsInScope.add(clean.toLowerCase());
                        });
                    } else if (Array.isArray(val)) {
                        val.forEach((v: unknown) => {
                            if (typeof v === 'string') {
                                const clean = v.startsWith('#') ? v.substring(1) : v;
                                tagsInScope.add(clean.toLowerCase());
                            }
                        });
                    }
                };
                if (cache.frontmatter.tags) extract(cache.frontmatter.tags);
                if (cache.frontmatter.tag) extract(cache.frontmatter.tag);
            }
        }

        const missingTags: string[] = [];
        for (const child of toNest) {
            if (!tagsInScope.has(child.toLowerCase())) {
                missingTags.push('#' + child);
            }
        }

        if (missingTags.length > 0) {
            new Notice(`Nest aborted: ${missingTags.join(', ')} not found in current scope. Check for typos or scope filters.`);
            return;
        }

        new Notice(`Nesting ${toNest.length} tags under #${parentClean}...`);

        this.isBulkOperationInProgress = true;
        const progressModal = new ProgressModal(this.app, files.length);
        progressModal.open();

        let processedCount = 0;
        const changes: FileChange[] = [];

        // Build a single regex that matches any of the child tags
        const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const childPatterns = toNest.map(s => escapeRegExp(s)).join('|');
        const tagRegex = new RegExp(`(^|\\s)(#)((?:${childPatterns})(?:\\/[\\p{L}\\p{N}_\\-]+)*)(?=[\\s]|$|[^\\p{L}\\p{N}_\\/-])`, 'gu');

        for (const file of files) {
            tagRegex.lastIndex = 0;
            try {
                const before = await this.app.vault.read(file);
                let modified = false;

                // Process frontmatter tags
                await this.app.fileManager.processFrontMatter(file, (fm) => {
                    const processSingleTag = (t: string): string => {
                        if (typeof t !== 'string') return t;
                        const hasHash = t.startsWith('#');
                        const raw = hasHash ? t.substring(1) : t;
                        if (this.isTagProtected(raw)) return t;

                        for (const [child, nested] of renameMap) {
                            if (raw === child) {
                                modified = true;
                                return hasHash ? '#' + nested : nested;
                            }
                            if (raw.startsWith(child + '/')) {
                                modified = true;
                                const newRaw = nested + raw.substring(child.length);
                                return hasHash ? '#' + newRaw : newRaw;
                            }
                        }
                        return t;
                    };

                    const handleTagKey = (key: string) => {
                        if (!fm[key]) return;
                        if (Array.isArray(fm[key])) {
                            const newTags = fm[key].map(processSingleTag);
                            // Deduplicate
                            const uniqueTags: string[] = [];
                            const seen = new Set<string>();
                            for (const t of newTags) {
                                const clean = typeof t === 'string' && t.startsWith('#') ? t.substring(1) : t;
                                if (!seen.has(clean)) { seen.add(clean); uniqueTags.push(t); }
                            }
                            if (uniqueTags.length !== fm[key].length || uniqueTags.some((t: string, i: number) => t !== fm[key][i])) {
                                fm[key] = uniqueTags;
                                modified = true;
                            }
                        } else if (typeof fm[key] === 'string') {
                            const newTag = processSingleTag(fm[key]);
                            if (newTag !== fm[key]) { fm[key] = newTag; modified = true; }
                        }
                    };

                    handleTagKey('tags');
                    handleTagKey('tag');
                });

                // Process inline body tags
                let after = before;
                await this.app.vault.process(file, (data) => {
                    const codeBlockRanges = this.getCodeBlockRanges(data);
                    const fmMatch = data.match(/^---\n[\s\S]*?\n---/);
                    const skipStart = fmMatch ? fmMatch[0].length : 0;

                    const newData = data.replace(tagRegex, (match, prefix, hash, capturedTag, offset) => {
                        if (offset < skipStart) return match;
                        if (this.isInCodeBlockRange(offset, codeBlockRanges)) return match;
                        if (this.isTagProtected(capturedTag)) return match;

                        // Find which child tag matched and replace with nested version
                        for (const [child, nested] of renameMap) {
                            if (capturedTag === child) {
                                modified = true;
                                return prefix + hash + nested;
                            }
                            if (capturedTag.startsWith(child + '/')) {
                                modified = true;
                                return prefix + hash + nested + capturedTag.substring(child.length);
                            }
                        }
                        return match;
                    });

                    tagRegex.lastIndex = 0;
                    after = newData;
                    return newData;
                });

                if (modified && before !== after) {
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
        this.isBulkOperationInProgress = false;

        progressModal.close();

        if (changes.length > 0) {
            await this.addToHistory({
                type: 'nest',
                description: `Nest ${toNest.map(s => '#' + s).join(', ')} → #${parentClean}/...`,
                changes
            });
            new Notice(`Nested ${toNest.length} tags under #${parentClean}. ${changes.length} files changed.`);
        } else {
            new Notice(`No files were modified. (Tags might not exist in the current scope)`);
        }
    }

    async renameTagBatch(pairs: { from: string; to: string }[]) {
        const validPairs = pairs
            .map(p => ({
                from: p.from.replace(/^#/, '').trim(),
                to: p.to.replace(/^#/, '').trim()
            }))
            .filter(p => p.from && p.to && p.from !== p.to);

        if (validPairs.length === 0) {
            new Notice('No valid rename pairs found.');
            return;
        }

        const protectedPairs = validPairs.filter(p => this.isTagProtected(p.from));
        if (protectedPairs.length > 0) {
            new Notice(`⚠️ Protected tags skipped: ${protectedPairs.map(p => '#' + p.from).join(', ')}`);
        }

        const executablePairs = validPairs.filter(p => !this.isTagProtected(p.from));
        if (executablePairs.length === 0) {
            new Notice('All pairs are protected. Nothing to rename.');
            return;
        }

        // Validate target tag names
        for (const p of executablePairs) {
            if (!/^[\p{L}\p{N}_\-/]+$/u.test(p.to)) {
                new Notice(`Invalid target tag name: #${p.to}`);
                return;
            }
        }

        const renameMap = new Map<string, string>(executablePairs.map(p => [p.from, p.to]));

        const files = this.getFilteredFiles();
        const changes: FileChange[] = [];

        // Validate all source tags exist in scope
        const tagsInScope = new Set<string>();
        for (const file of files) {
            const cache = this.app.metadataCache.getFileCache(file);
            if (cache?.tags) {
                cache.tags.forEach(t => tagsInScope.add(
                    (t.tag.startsWith('#') ? t.tag.substring(1) : t.tag).toLowerCase()
                ));
            }
            if (cache?.frontmatter) {
                const extract = (val: unknown) => {
                    if (typeof val === 'string') {
                        val.split(',').forEach((v: string) => {
                            const clean = v.trim().startsWith('#') ? v.trim().substring(1) : v.trim();
                            if (clean) tagsInScope.add(clean.toLowerCase());
                        });
                    } else if (Array.isArray(val)) {
                        val.forEach((v: unknown) => {
                            if (typeof v === 'string') {
                                const clean = v.startsWith('#') ? v.substring(1) : v;
                                tagsInScope.add(clean.toLowerCase());
                            }
                        });
                    }
                };
                if (cache.frontmatter.tags) extract(cache.frontmatter.tags);
                if (cache.frontmatter.tag) extract(cache.frontmatter.tag);
            }
        }

        const missingTags = executablePairs
            .map(p => p.from)
            .filter(f => !tagsInScope.has(f.toLowerCase()));

        if (missingTags.length > 0) {
            new Notice(`Warning: ${missingTags.length} source tag(s) not found in scope: ${missingTags.slice(0, 5).map(t => '#' + t).join(', ')}${missingTags.length > 5 ? '…' : ''}. Continuing with found tags.`);
        }

        new Notice(`Renaming ${executablePairs.length} tags...`);

        const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const sourcePatterns = executablePairs.map(p => escapeRegExp(p.from)).join('|');
        const tagRegex = new RegExp(
            `(^|\\s)(#)((?:${sourcePatterns})(?:\\/[\\p{L}\\p{N}_\\-]+)*)(?=[\\s]|$|[^\\p{L}\\p{N}_\\/-])`,
            'gu'
        );

        this.isBulkOperationInProgress = true;
        const progressModal = new ProgressModal(this.app, files.length);
        progressModal.open();
        let processedCount = 0;

        for (const file of files) {
            tagRegex.lastIndex = 0;
            try {
                const before = await this.app.vault.read(file);
                let modified = false;

                await this.app.fileManager.processFrontMatter(file, (fm) => {
                    const processSingleTag = (t: string): string => {
                        if (typeof t !== 'string') return t;
                        const hasHash = t.startsWith('#');
                        const raw = hasHash ? t.substring(1) : t;
                        if (this.isTagProtected(raw)) return t;
                        for (const [from, to] of renameMap) {
                            if (raw === from) { modified = true; return hasHash ? '#' + to : to; }
                            if (raw.startsWith(from + '/')) {
                                modified = true;
                                return hasHash ? '#' + to + raw.substring(from.length) : to + raw.substring(from.length);
                            }
                        }
                        return t;
                    };

                    const handleTagKey = (key: string) => {
                        if (!fm[key]) return;
                        if (Array.isArray(fm[key])) {
                            const newTags = fm[key].map(processSingleTag);
                            const uniqueTags: string[] = [];
                            const seen = new Set<string>();
                            for (const t of newTags) {
                                const clean = typeof t === 'string' && t.startsWith('#') ? t.substring(1) : t;
                                if (!seen.has(clean)) { seen.add(clean); uniqueTags.push(t); }
                            }
                            if (uniqueTags.length !== fm[key].length || uniqueTags.some((t: string, i: number) => t !== fm[key][i])) {
                                fm[key] = uniqueTags;
                                modified = true;
                            }
                        } else if (typeof fm[key] === 'string') {
                            const n = processSingleTag(fm[key]);
                            if (n !== fm[key]) { fm[key] = n; modified = true; }
                        }
                    };

                    handleTagKey('tags');
                    handleTagKey('tag');
                });

                let after = before;
                await this.app.vault.process(file, (data) => {
                    const codeBlockRanges = this.getCodeBlockRanges(data);
                    const fmMatch = data.match(/^---\n[\s\S]*?\n---/);
                    const skipStart = fmMatch ? fmMatch[0].length : 0;

                    const newData = data.replace(tagRegex, (match, prefix, hash, capturedTag, offset) => {
                        if (offset < skipStart) return match;
                        if (this.isInCodeBlockRange(offset, codeBlockRanges)) return match;
                        if (this.isTagProtected(capturedTag)) return match;
                        for (const [from, to] of renameMap) {
                            if (capturedTag === from) { modified = true; return prefix + hash + to; }
                            if (capturedTag.startsWith(from + '/')) {
                                modified = true;
                                return prefix + hash + to + capturedTag.substring(from.length);
                            }
                        }
                        return match;
                    });
                    tagRegex.lastIndex = 0;
                    after = newData;
                    return newData;
                });

                if (modified && before !== after) changes.push({ path: file.path, before, after });
                processedCount++;
                progressModal.update(processedCount);
            } catch (e) {
                console.error(`renameTagBatch failed on ${file.path}`, e);
                processedCount++;
                progressModal.update(processedCount);
            }
        }

        this.isBulkOperationInProgress = false;
        progressModal.close();

        if (changes.length > 0) {
            await this.addToHistory({
                type: 'rename',
                description: `Batch rename: ${executablePairs.length} pairs (${changes.length} files changed)`,
                changes
            });
            new Notice(`Batch rename complete: ${changes.length} files changed.`);
        } else {
            new Notice('Batch rename: no files modified.');
        }
    }

    async deleteTags(tagsToDelete: string[], silent = false): Promise<number> {
        const cleanTags = tagsToDelete
            .map(t => t.startsWith('#') ? t.substring(1) : t)
            .filter(t => t.length > 0);

        const deletableTags = cleanTags.filter(t => !this.isTagProtected(t));
        const protectedTags = cleanTags.filter(t => this.isTagProtected(t));

        if (protectedTags.length > 0) {
            new Notice(`⚠️ Skipping protected tags: ${protectedTags.map(t => '#' + t).join(', ')}`);
        }

        if (deletableTags.length === 0) {
            if (protectedTags.length === 0) new Notice('No valid tags to delete.');
            return 0;
        }

        const files = this.getFilteredFiles();
        const changes: FileChange[] = [];

        new Notice(`Deleting ${deletableTags.length} tags...`);

        this.isBulkOperationInProgress = true;
        const progressModal = new ProgressModal(this.app, files.length);
        progressModal.open();
        let processedCount = 0;

        const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        // Match exact tag OR tag/child
        const patternParts = deletableTags.map(t => `(?:${escapeRegExp(t)}(?:\\/[\\p{L}\\p{N}_\\-]+)*)`);
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
                        if (this.isTagProtected(raw)) return false;
                        // Check if raw is one of the tags to delete or a child of them
                        return deletableTags.some(del => raw === del || raw.startsWith(del + '/'));
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
                    const fmMatch = data.match(/^---\n[\s\S]*?\n---/);
                    const skipStart = fmMatch ? fmMatch[0].length : 0;
                    let newData = data.replace(tagRegex, (match, prefix, hash, tag, offset) => {
                        if (offset < skipStart) return match;
                        if (this.isInCodeBlockRange(offset, codeBlockRanges)) return match;

                        modified = true;
                        return prefix.trimEnd(); // Remove trailing space to prevent double-space artifacts
                    });
                    // B01: Collapse any remaining double spaces in the body
                    if (modified) {
                        const bodyStart = skipStart;
                        const body = newData.substring(bodyStart);
                        newData = newData.substring(0, bodyStart) + body.replace(/ {2,}/g, ' ');
                    }
                    after = newData;
                    return newData;
                });

                if (modified && before !== after) {
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
        this.isBulkOperationInProgress = false;

        progressModal.close();

        if (changes.length > 0) {
            await this.addToHistory({
                type: 'delete',
                description: `Deleted tags: ${deletableTags.join(', ')}`,
                changes
            });
            if (!silent) new Notice(`Deleted tags from ${changes.length} files.`);
        } else {
            if (!silent) new Notice('No tags deleted.');
        }
        return changes.length;
    }

    async batchRename(pattern: string, replacement: string) {
        const files = this.getFilteredFiles();
        const changes: FileChange[] = [];
        let regex: RegExp;

        // Issue 12: Basic ReDoS protection
        const looksComplex =
            pattern.length > 100 ||
            /([+*?])\1+/.test(pattern) ||
            /\([^)]*[+*][^)]*\)\+/.test(pattern);
        if (looksComplex) {
            new Notice('Regex pattern is too complex. Please simplify.');
            return;
        }

        try {
            regex = new RegExp(pattern, 'g');
        } catch {
            new Notice('Invalid regex pattern.');
            return;
        }

        this.isBulkOperationInProgress = true;
        const progressModal = new ProgressModal(this.app, files.length);
        progressModal.open();

        let processedCount = 0;

        for (const file of files) {
            try {
                const before = await this.app.vault.read(file);
                let after = before;

                // Process frontmatter tags
                await this.app.fileManager.processFrontMatter(file, (fm) => {
                    const processSingleTag = (t: string): string => {
                        if (typeof t !== 'string') return t;
                        const hasHash = t.startsWith('#');
                        const raw = hasHash ? t.substring(1) : t;
                        if (this.isTagProtected(raw)) return t;
                        regex.lastIndex = 0;
                        const newRaw = raw.replace(regex, replacement);
                        if (newRaw !== raw) return hasHash ? '#' + newRaw : newRaw;
                        return t;
                    };
                    if (fm.tags) {
                        if (Array.isArray(fm.tags)) {
                            const newTags = fm.tags.map(processSingleTag);
                            if (newTags.some((t: string, i: number) => t !== fm.tags[i])) fm.tags = newTags;
                        } else if (typeof fm.tags === 'string') {
                            const newTag = processSingleTag(fm.tags);
                            if (newTag !== fm.tags) fm.tags = newTag;
                        }
                    }
                    if (fm.tag) {
                        if (Array.isArray(fm.tag)) {
                            const newTags = fm.tag.map(processSingleTag);
                            if (newTags.some((t: string, i: number) => t !== fm.tag[i])) fm.tag = newTags;
                        } else if (typeof fm.tag === 'string') {
                            const newTag = processSingleTag(fm.tag);
                            if (newTag !== fm.tag) fm.tag = newTag;
                        }
                    }
                });

                // Process inline tags (body only — frontmatter already handled above)
                await this.app.vault.process(file, (data) => {
                    const codeBlockRanges = this.getCodeBlockRanges(data);
                    const fmMatch = data.match(/^---\n[\s\S]*?\n---/);
                    const skipStart = fmMatch ? fmMatch[0].length : 0;
                    const newData = data.replace(TAG_REGEX, (fullMatch, prefix, tag, offset) => {
                        if (offset < skipStart) return fullMatch;
                        if (this.isInCodeBlockRange(offset, codeBlockRanges)) return fullMatch;
                        if (this.isTagProtected(tag)) return fullMatch;
                        regex.lastIndex = 0;
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
        this.isBulkOperationInProgress = false;

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
        const tags = this.app.metadataCache.getTags();
        const root: TagNode[] = [];

        for (const tag of Object.keys(tags)) {
            const count = tags[tag];
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

        const accumulate = (nodes: TagNode[]): number => {
            let total = 0;
            for (const node of nodes) {
                node.count += accumulate(node.children);
                total += node.count;
            }
            return total;
        };
        
        accumulate(root);

        return root;
    }

    findOrphanedTags(): { tag: string; count: number }[] {
        const tags = this.app.metadataCache.getTags();
        return Object.keys(tags)
            .map(tag => ({ tag, count: tags[tag] }))
            .filter(({ count }) => count < this.settings.orphanThreshold)
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
                const extractTags = (val: unknown) => {
                    if (typeof val === 'string') val.split(',').forEach(t => tagSet.add(t.trim().startsWith('#') ? t.trim() : '#' + t.trim()));
                    else if (Array.isArray(val)) val.forEach((t: unknown) => typeof t === 'string' && tagSet.add(t.startsWith('#') ? t : '#' + t));
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
            wikiLinkStats: { yamlList: [], inlineArray: [] },
            inlineFiles: [],
            nestedFiles: [],
            quotedFrontmatterCount: 0,
            quotedFrontmatterFiles: [],
            caseDuplicates: []
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
                            if (/^[^\s:]+:\s*\[?\s*["'](?![[{@#*&!%>|])/.test(line)) return true;
                            // Match indented list items: - "val"
                            if (/^\s+-\s*["'](?![[{@#*&!%>|])/.test(line)) return true;
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
                                        stats.formatStats.inlineArray.push(file);
                                    }
                                    break;
                                }
                            }
                        }

                        // Wiki Link Analysis (Refined logic)
                        const fm = cache.frontmatter;
                        let fileHasWikiList = false;
                        let fileHasWikiInline = false;

                        for (const key in fm) {
                            if (key.toLowerCase() === 'tags' || key.toLowerCase() === 'tag') continue;

                            const val = fm[key];
                            if (val === null || val === undefined) continue;

                            const valArray = Array.isArray(val) ? val : [val];
                            
                            // 1. Is this a wiki link property?
                            const isWikiLinkProperty = valArray.some(v => {
                                if (typeof v === 'string') return v.trim().startsWith('[[') && v.trim().endsWith(']]');
                                if (Array.isArray(v) && v.length === 1 && typeof v[0] === 'string') return true; 
                                return false;
                            });

                            if (isWikiLinkProperty) {
                                // 2. Peek at the raw lines to see HOW it is formatted
                                const keyEscaped = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
                                const keyRegex = new RegExp(`^${keyEscaped}:`);
                                const keyLineIndex = lines.findIndex(l => keyRegex.test(l));
                                
                                if (keyLineIndex !== -1) {
                                    const line = lines[keyLineIndex];
                                    const valueStr = line.substring(line.indexOf(':') + 1).trim();
                                    
                                    // If the line has no value next to the key, it must be a multiline list below it
                                    if (!valueStr || valueStr === '') {
                                        fileHasWikiList = true;
                                    } 
                                    // If it explicitly starts with an array bracket (and isn't just an unquoted [[link]])
                                    else if (valueStr.startsWith('[') && !valueStr.startsWith('[[')) {
                                        fileHasWikiInline = true;
                                    }
                                    // If it's a single item like "[[Link]]" or [[Link]], treat it as inline for stats purposes
                                    else {
                                        fileHasWikiInline = true; 
                                    }
                                }
                            }
                        }

                        // Categorize the file based on what we found
                        if (fileHasWikiList) stats.wikiLinkStats.yamlList.push(file);
                        if (fileHasWikiInline) stats.wikiLinkStats.inlineArray.push(file);
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
            const letters = rawTag.replace(/[^\p{L}]/gu, '');
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
            const hasSpecial = /[^\p{L}\p{N}_/-]/u.test(rawTag);
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

        // --- 3. Duplicate Detection across case variants ---
        const globalTags = this.app.metadataCache.getTags();
        const caseGroups = new Map<string, string[]>();

        tags.forEach(tag => {
            const normalized = tag.replace(/^#/, '').toLowerCase();
            if (!caseGroups.has(normalized)) caseGroups.set(normalized, []);
            caseGroups.get(normalized)?.push(tag);
        });

        const duplicates: { canonical: string, variants: string[] }[] = [];
        caseGroups.forEach((variants) => {
            if (variants.length > 1) {
                const canonical = variants.reduce((a, b) => {
                    // NORMALIZED LOOKUP: Always use # prefix for count check
                    const countA = globalTags['#' + a.replace(/^#/, '')] || 0;
                    const countB = globalTags['#' + b.replace(/^#/, '')] || 0;
                    
                    if (countA !== countB) return countA > countB ? a : b;
                    // Tie-breaker: Case-sensitive comparison for stability (e.g., "React" beats "react")
                    return a < b ? a : b;
                });
                duplicates.push({ canonical, variants });
            }
        });
        stats.caseDuplicates = duplicates;

        return stats;
    }


    async findInvalidTagFormats(): Promise<InvalidTagFile[]> {
        const invalidFiles: InvalidTagFile[] = [];
        const files = this.getFilteredFiles();

        // Exact list of prohibited characters from USER_REQUEST
        const INVALID_CHARS = /[#!@£$%^&*()=+[\]{}:;'",.<>?|\\]/;
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
                const checkFMKey = (key: string, value: unknown) => {
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
                        value.forEach((t: unknown) => {
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

    async convertTagFormat(files: TFile[], format: 'inline' | 'list', silent = false) {
        this.isBulkOperationInProgress = true;
        const progressModal = !silent ? new ProgressModal(this.app, files.length) : null;
        if (progressModal) progressModal.open();
        let count = 0;
        let processed = 0;
        const changes: FileChange[] = [];

        for (const file of files) {
            try {
                const before = await this.app.vault.read(file);
                await this.app.vault.process(file, (content) => {
                    const fmMatch = content.match(/^---\n([\s\S]*?)\n---/);
                    if (!fmMatch) return content;

                    const fmContent = fmMatch[1];
                    const lines = fmContent.split('\n');
                    let keyIndex = -1;
                    let keyName = '';

                    // Find 'tags:' or 'tag:'
                    for (let i = 0; i < lines.length; i++) {
                        const m = lines[i].match(/^(tags?):/i);
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

                    // Get current tags value from the lines directly (Bug 3 Fix)
                    const valueLine = lines[keyIndex];
                    const inlineValue = valueLine.substring(valueLine.indexOf(':') + 1).trim();
                    let tags: string[] = [];

                    if (inlineValue && inlineValue !== '') {
                        if (inlineValue.startsWith('[') && inlineValue.endsWith(']')) {
                            // Single-line inline array: [a, b]
                            tags = inlineValue.substring(1, inlineValue.length - 1)
                                .split(',')
                                .map(t => t.trim().replace(/^["']|["']$/g, ''))
                                .filter(t => t.length > 0);
                        } else if (inlineValue.startsWith('[')) {
                            // B03: Multiline inline array: tags: [\n  a,\n  b\n]
                            let arrayContent = inlineValue.substring(1); // after '['
                            let arrayEndIndex = keyIndex;
                            for (let i = keyIndex + 1; i <= endIndex; i++) {
                                const lineTrimmed = lines[i].trim();
                                arrayContent += ' ' + lineTrimmed;
                                if (lineTrimmed.endsWith(']')) {
                                    arrayEndIndex = i;
                                    break;
                                }
                                arrayEndIndex = i;
                            }
                            // Strip trailing ']'
                            if (arrayContent.endsWith(']')) {
                                arrayContent = arrayContent.substring(0, arrayContent.length - 1);
                            }
                            tags = arrayContent
                                .split(',')
                                .map(t => t.trim().replace(/^["']|["']$/g, ''))
                                .filter(t => t.length > 0);
                            // Extend endIndex to cover all consumed lines
                            endIndex = Math.max(endIndex, arrayEndIndex);
                        } else {
                            // Single value: tag1
                            tags = [inlineValue.replace(/^["']|["']$/g, '')];
                        }
                    } else if (endIndex > keyIndex) {
                        // YAML List
                        for (let i = keyIndex + 1; i <= endIndex; i++) {
                            const line = lines[i].trim();
                            if (line.startsWith('-')) {
                                const val = line.substring(1).trim().replace(/^["']|["']$/g, '');
                                // HARD IGNORE: If this is the specific template placeholder, skip this file
                                if (val.includes('{ tags }')) return content;
                                tags.push(val);
                            }
                        }
                    }

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

                    // Bug 1 Fix: Correct fmEnd logic
                    const fmStart = content.indexOf('---\n');
                    const fmEndRaw = content.indexOf('\n---', fmStart + 4);
                    if (fmStart === -1 || fmEndRaw === -1) return content;
                    const fmEnd = fmEndRaw + 4;

                    return content.substring(0, fmStart + 4) + lines.join('\n') + content.substring(fmEnd - 4);
                });
                const after = await this.app.vault.read(file);
                if (before !== after) {
                    changes.push({ path: file.path, before, after });
                    count++;
                }
                processed++;
                if (progressModal) progressModal.update(processed);
            } catch (e) {
                console.error('Format conversion failed', e);
                processed++;
                if (progressModal) progressModal.update(processed);
            }
        }
        this.isBulkOperationInProgress = false;
        if (changes.length > 0) {
            await this.addToHistory({
                type: 'tag-format',
                description: `Convert tags to ${format === 'inline' ? 'Inline Array' : 'YAML List'} (${changes.length} files)`,
                changes,
            });
        }
        if (!silent) {
            progressModal?.close();
            new Notice(`Converted tags to ${format === 'inline' ? 'Inline Array' : 'YAML List'} in ${count} files.`);
        }
    }

    async convertWikiLinkFormat(files: TFile[], format: 'inline' | 'list', silent = false) {
        this.isBulkOperationInProgress = true;
        const progressModal = !silent ? new ProgressModal(this.app, files.length) : null;
        if (progressModal) progressModal.open();
        let count = 0;
        let processed = 0;
        const changes: FileChange[] = [];

        for (const file of files) {
            try {
                const before = await this.app.vault.read(file);
                await this.app.vault.process(file, (content) => {
                    const fmMatch = content.match(/^---\n([\s\S]*?)\n---/);
                    if (!fmMatch) return content;

                    const fmContent = fmMatch[1];
                    const lines = fmContent.split('\n');
                    let modified = false;

                    // 1. Identify all wiki-link properties directly from lines (Bug 3 Fix)
                    const propertiesToConvert: { key: string, values: string[], start: number, end: number }[] = [];
                    
                    for (let i = 0; i < lines.length; i++) {
                        const line = lines[i];
                        const keyMatch = line.match(/^([^\s:]+):(.*)$/);
                        if (!keyMatch) continue;

                        const key = keyMatch[1];
                        if (key.toLowerCase() === 'tags' || key.toLowerCase() === 'tag') continue;

                        const valueStr = keyMatch[2].trim();
                        let propertyValues: string[] = [];
                        let endIndex = i;

                        if (valueStr !== '') {
                            // Inline
                            if (valueStr.startsWith('[') && valueStr.endsWith(']')) {
                                // Inline array: [a, b]
                                const innerStr = valueStr.substring(1, valueStr.length - 1);
                                // Matches double-quoted strings, single-quoted strings, or bare values separated by commas
                                const matches = innerStr.match(/"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|[^,]+/g) || [];
                                propertyValues = matches.map(v => v.trim().replace(/^["']|["']$/g, ''));
                            } else {
                                // Single value: tag1
                                propertyValues = [valueStr.replace(/^["']|["']$/g, '')];
                            }
                        } else {
                            // Possible Multiline
                            for (let j = i + 1; j < lines.length; j++) {
                                if (lines[j].match(/^\S/)) break;
                                const listMatch = lines[j].trim().match(/^-\s*(.*)$/);
                                if (listMatch) {
                                    propertyValues.push(listMatch[1].trim().replace(/^["']|["']$/g, ''));
                                    endIndex = j;
                                }
                            }
                        }

                        // Check if it's a wiki-link property (refined detection)
                        const isWikiLink = propertyValues.some(v => v.startsWith('[[') && v.endsWith(']]'));

                        if (isWikiLink && propertyValues.length > 0) {
                            propertiesToConvert.push({ key, values: propertyValues, start: i, end: endIndex });
                        }
                        
                        // Skip the lines we already processed for this property
                        i = endIndex;
                    }

                    // 2. Process conversions (Reverse order to keep indices stable)
                    for (let i = propertiesToConvert.length - 1; i >= 0; i--) {
                        const prop = propertiesToConvert[i];
                        const quotedLinks = prop.values.map(l => `"${l.replace(/"/g, '\\"')}"`);
                        const newLines: string[] = [];

                        if (format === 'inline') {
                            newLines.push(`${prop.key}: [${quotedLinks.join(', ')}]`);
                        } else {
                            newLines.push(`${prop.key}:`);
                            quotedLinks.forEach(l => newLines.push(`  - ${l}`));
                        }

                        lines.splice(prop.start, prop.end - prop.start + 1, ...newLines);
                        modified = true;
                    }

                    if (!modified) return content;

                    // Bug 1 Fix: Correct fmEnd logic
                    const fmStart = content.indexOf('---\n');
                    const fmEndRaw = content.indexOf('\n---', fmStart + 4);
                    if (fmStart === -1 || fmEndRaw === -1) return content;
                    const fmEnd = fmEndRaw + 4;

                    return content.substring(0, fmStart + 4) + lines.join('\n') + content.substring(fmEnd - 4);
                });
                const after = await this.app.vault.read(file);
                if (before !== after) {
                    changes.push({ path: file.path, before, after });
                    count++;
                }
                processed++;
                if (progressModal) progressModal.update(processed);
            } catch (e) {
                console.error('Wiki link format conversion failed', e);
                processed++;
                if (progressModal) progressModal.update(processed);
            }
        }
        this.isBulkOperationInProgress = false;
        if (changes.length > 0) {
            await this.addToHistory({
                type: 'wiki-link-format',
                description: `Convert wiki links to ${format === 'inline' ? 'Inline Array' : 'YAML List'} (${changes.length} files)`,
                changes,
            });
        }
        if (!silent) {
            progressModal?.close();
            new Notice(`Converted wiki links to ${format === 'inline' ? 'Inline Array' : 'YAML List'} in ${count} files.`);
        }
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
                if (this.isTagProtected(raw)) return t;
                // Exact match
                if (aliases[raw]) {
                    modified = true;
                    return hasHash ? '#' + aliases[raw] : aliases[raw];
                }
                // B04: Child tag match — if raw starts with aliasKey/, preserve suffix
                for (const [aliasKey, aliasValue] of Object.entries(aliases)) {
                    if (raw.startsWith(aliasKey + '/')) {
                        modified = true;
                        const newRaw = aliasValue + raw.substring(aliasKey.length);
                        return hasHash ? '#' + newRaw : newRaw;
                    }
                }
                return t;
            };

            // Issue 8: Idempotency check
            if (fm.tags) {
                if (Array.isArray(fm.tags)) {
                    const newTags = fm.tags.map(processSingleTag);
                    if (newTags.some((t: string, i: number) => t !== fm.tags[i])) fm.tags = newTags;
                } else if (typeof fm.tags === 'string') {
                    const newTag = processSingleTag(fm.tags);
                    if (newTag !== fm.tags) fm.tags = newTag;
                }
            }
            if (fm.tag) {
                if (Array.isArray(fm.tag)) {
                    const newTags = fm.tag.map(processSingleTag);
                    if (newTags.some((t: string, i: number) => t !== fm.tag[i])) fm.tag = newTags;
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
                    if (this.isTagProtected(captured)) return m;
                    
                    modified = true;
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
                if (this.isTagProtected(clean)) return t;
                const converted = this.convertTagContent(clean, overrides);
                return hasHash ? '#' + converted : converted;
            };

            // Issue 8: Only assign back if something actually changed
            if (fm.tags) {
                if (Array.isArray(fm.tags)) {
                    const newTags = fm.tags.map(processSingleTag);
                    if (newTags.some((t: string, i: number) => t !== fm.tags[i])) {
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
                    if (newTags.some((t: string, i: number) => t !== fm.tag[i])) {
                        fm.tag = newTags;
                    }
                } else if (typeof fm.tag === 'string') {
                    const newTag = processSingleTag(fm.tag);
                    if (newTag !== fm.tag) fm.tag = newTag;
                }
            }
        });

        await this.app.vault.process(file, (data) => {
            const codeBlockRanges = this.getCodeBlockRanges(data);
            const fmMatch = data.match(/^---\n[\s\S]*?\n---/);
            const skipStart = fmMatch ? fmMatch[0].length : 0;
            finalContent = this.transformContent(data, skipStart, codeBlockRanges, overrides);
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

    private transformContent(content: string, skipStart: number, codeBlocks: { start: number; end: number }[], overrides?: { caseStrategy?: 'lowercase' | 'uppercase' | 'none' }): string {
        return content.replace(TAG_REGEX, (fullMatch, prefix, tag, offset) => {
            if (offset < skipStart) return fullMatch;
            if (codeBlocks.some(b => offset >= b.start && offset < b.end)) return fullMatch;
            if (this.isTagProtected(tag.substring(1))) return fullMatch;

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

        try {
            this.isBulkOperationInProgress = true;
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

            if (changes.length > 0) {
                await this.addToHistory({
                    type: 'convert',
                    description: `Bulk convert to ${targetCase} (${changes.length} files)`,
                    changes
                });
            }
            new Notice(`Converted tags to ${targetCase} in ${changes.length} files.`);
        } finally {
            this.isBulkOperationInProgress = false;
            progressModal.close();
        }
    }

    getAllTags(): string[] {
        const tags = this.app.metadataCache.getTags();
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
        if (fill) fill.setCssProps({ width: `${percent}%` });
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
    private onConfirm: (files: PreviewFile[]) => void | Promise<void>;

    constructor(app: App, plugin: TagLowercasePlugin, preview: PreviewResult, onConfirm: (files: PreviewFile[]) => void | Promise<void>) {
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
        
        contentEl.createEl('p', {
            cls: 'btm-preview-warning',
            text: 'Note: Detailed line diffs for frontmatter tags are not shown, but they will be standardized.',
        });

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
            const selected = this.preview.affectedFiles.filter(f => f.included);
            this.close();
            runAsync(async () => {
                await this.onConfirm(selected);
            });
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
            });
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
                if (op.nonRevertible) {
                    itemEl.createDiv({
                        cls: 'btm-history-warning',
                        text: '⚠ Snapshots omitted due to size - cannot undo.',
                    });
                } else {
                    const revertBtn = itemEl.createEl('button', { text: 'Undo', cls: 'btm-revert-btn' });
                    revertBtn.onclick = () => {
                        this.close();
                        void this.plugin.undoLastOperation();
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
    private onConfirm: () => void | Promise<void>;
    private title: string;

    constructor(app: App, title: string, message: string, onConfirm: () => void | Promise<void>) {
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
            runAsync(async () => {
                await this.onConfirm();
            });
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
    private sortStrategy: TagHierarchySortStrategy = 'alphabetical';
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
        
        controlRow.createSpan({ text: 'Sort by:', cls: 'btm-control-label' });
        const dropdown = new DropdownComponent(controlRow)
            .addOption('alphabetical', 'A-Z')
            .addOption('nesting', 'Nested Count')
            .addOption('usage', 'Usage')
            .setValue(this.sortStrategy)
            .onChange((value) => {
                if (value === 'alphabetical' || value === 'nesting' || value === 'usage') {
                    this.sortStrategy = value;
                    this.updateDisplay();
                }
            });
        dropdown.selectEl.addClass('btm-tree-sort-dropdown');

        controlRow.createDiv({ cls: 'btm-spacer' });

        const expandBtn = controlRow.createEl('button', { text: 'Expand All', cls: 'btm-tiny-btn' });
        const collapseBtn = controlRow.createEl('button', { text: 'Collapse All', cls: 'btm-tiny-btn' });
        const copyBtn = controlRow.createEl('button', { text: 'Copy All', cls: 'btm-tiny-btn' });

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

        copyBtn.onclick = () => {
            const clonedHierarchy = this.deepCloneNodes(this.hierarchy);
            const filtered = this.filterNodes(clonedHierarchy, this.searchQuery);
            this.sortNodes(filtered);
            const tags = this.flattenNodes(filtered);
            const text = tags.map(t => `#${t}`).join('\n');

            runAsync(async () => {
                try {
                    await navigator.clipboard.writeText(text);
                    new Notice(`Copied ${tags.length} tag${tags.length === 1 ? '' : 's'} to clipboard.`);
                } catch (err) {
                    console.error('Failed to copy tags to clipboard', err);
                    new Notice('Failed to copy tags to clipboard.');
                }
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
        const filtered = this.filterNodes(clonedHierarchy, this.searchQuery);
        this.sortNodes(filtered);
        this.renderTree(this.treeEl, filtered, 0);
    }

    private flattenNodes(nodes: TagNode[]): string[] {
        const results: string[] = [];
        const walk = (node: TagNode) => {
            results.push(node.fullPath);
            for (const child of node.children) {
                walk(child);
            }
        };

        for (const node of nodes) {
            walk(node);
        }

        return results;
    }

    private filterNodes(nodes: TagNode[], query: string): TagNode[] {
        if (!query) return this.deepCloneNodes(nodes);

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
                void this.app.workspace.openLinkText(item.path, '', false);
            };

            const issuesEl = itemEl.createDiv({ cls: 'btm-invalid-issues' });
            for (const issue of item.issues) {
                const issueEl = issuesEl.createDiv({ cls: 'btm-invalid-issue-manual' });
                
                const infoEl = issueEl.createDiv({ cls: 'btm-issue-info' });
                setIcon(infoEl.createSpan({ cls: 'btm-icon' }), 'alert-circle');
                infoEl.createSpan({ text: ' ' + issue.description });

                const actionRow = issueEl.createDiv({ cls: 'btm-fix-manual-row' });
                
                if (issue.tag) {
                    const input = new TextComponent(actionRow)
                        .setValue(issue.tag)
                        .setPlaceholder('Tag name...');
                    input.inputEl.addClass('btm-inline-input');
                    
                    const updateBtn = actionRow.createEl('button', { text: 'Update', cls: 'btm-small-btn mod-cta' });
                    updateBtn.onclick = () => {
                        runAsync(async () => {
                            const newValue = input.getValue();
                            const file = this.app.vault.getAbstractFileByPath(item.path);
                            if (file instanceof TFile) {
                                await this.app.fileManager.processFrontMatter(file, (fm) => {
                                    const updateOne = (key: string) => {
                                        if (fm[key]) {
                                            if (typeof fm[key] === 'string' && fm[key] === issue.tag) {
                                                fm[key] = newValue;
                                            } else if (Array.isArray(fm[key])) {
                                                const idx = fm[key].findIndex((t: unknown) => String(t) === issue.tag);
                                                if (idx > -1) fm[key][idx] = newValue;
                                            }
                                        }
                                    };
                                    updateOne('tags');
                                    updateOne('tag');
                                });
                                issueEl.remove();
                                this.checkEmpty(itemEl, issuesEl, listEl);
                                new Notice('Tag updated.');
                            }
                        });
                    };

                    const deleteBtn = actionRow.createEl('button', { text: 'Delete', cls: 'btm-small-btn mod-warning' });
                    deleteBtn.onclick = () => {
                        runAsync(async () => {
                            const file = this.app.vault.getAbstractFileByPath(item.path);
                            if (file instanceof TFile) {
                                await this.app.fileManager.processFrontMatter(file, (fm) => {
                                    const removeOne = (key: string) => {
                                        if (fm[key]) {
                                            if (typeof fm[key] === 'string' && fm[key] === issue.tag) {
                                                delete fm[key];
                                            } else if (Array.isArray(fm[key])) {
                                                const idx = fm[key].findIndex((t: unknown) => String(t) === issue.tag);
                                                if (idx > -1) fm[key].splice(idx, 1);
                                            }
                                        }
                                    };
                                    removeOne('tags');
                                    removeOne('tag');
                                });
                                issueEl.remove();
                                this.checkEmpty(itemEl, issuesEl, listEl);
                                new Notice('Tag deleted.');
                            }
                        });
                    };
                }

                const goBtn = actionRow.createEl('button', { text: 'Go to note', cls: 'btm-small-btn' });
                goBtn.onclick = () => {
                    this.close();
                    void this.app.workspace.openLinkText(item.path, '', false);
                };

                const ignoreBtn = actionRow.createEl('button', { text: 'Ignore', cls: 'btm-small-btn' });
                ignoreBtn.onclick = () => {
                    runAsync(async () => {
                        const id = `${item.path}|${issue.description}`;
                        this.plugin.settings.ignoredIssues.push(id);
                        await this.plugin.saveSettings();
                        issueEl.remove();
                        this.checkEmpty(itemEl, issuesEl, listEl);
                        new Notice('Issue ignored.');
                    });
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
                void this.app.workspace.openLinkText(file.path, '', false);
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
                void this.app.workspace.openLinkText(item.file.path, '', false);
            };

            headerEl.createSpan({ text: ` — ${item.count} inline tags`, cls: 'btm-highlight btm-inline-count' });

            const tagsEl = itemEl.createDiv({ cls: 'btm-metric-details btm-tags-list' });
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
                void this.app.workspace.openLinkText(item.file.path, '', false);
            };

            headerEl.createSpan({ text: ` — ${item.count} nested tags`, cls: 'btm-highlight btm-inline-count' });

            const tagsEl = itemEl.createDiv({ cls: 'btm-metric-details btm-tags-list' });
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
                const search = getGlobalSearch(this.app);
                if (search?.openGlobalSearch) {
                    search.openGlobalSearch(`tag:${tagText}`);
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
                    void this.app.workspace.openLinkText(file.path, '', false);
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
        this.modalEl.addClass('btm-modal-wide');

        new Setting(contentEl)
            .setName(this.title)
            .setDesc(`${this.errors.length} issues found. Click a path to open the note.`)
            .setHeading();

        const listEl = contentEl.createDiv({ cls: 'btm-file-list' });

        if (this.errors.length === 0) {
            listEl.createEl('p', { text: 'No errors to display.', cls: 'btm-loading' });
        } else {
            for (const err of this.errors) {
                const itemEl = listEl.createDiv({ cls: 'btm-file-item btm-file-item-error' });

                const pathLink = itemEl.createEl('a', { text: err.path, cls: 'btm-file-link' });
                pathLink.onclick = () => {
                    this.close();
                    void this.app.workspace.openLinkText(err.path, '', false);
                };

                itemEl.createDiv({ text: `Error: ${err.message}`, cls: 'btm-file-error-text' });

                // Add Fix button if it's a mapping error
                const msg = err.message.toLowerCase();
                if (msg.includes('mapping') || msg.includes('colon') || msg.includes('syntax')) {
                    const actionRow = itemEl.createDiv({ cls: 'btm-button-row btm-button-row-start' });

                    const fixBtn = actionRow.createEl('button', { text: 'Fix Syntax', cls: 'mod-cta btm-fix-syntax-btn' });
                    
                    fixBtn.onclick = () => {
                        runAsync(async () => {
                            const file = this.app.vault.getAbstractFileByPath(err.path);
                            if (file instanceof TFile) {
                                await this.plugin.fixInvalidMappingError(file);
                                itemEl.addClass('is-fixed');
                                fixBtn.disabled = true;
                                fixBtn.setText('Fixed');
                                new Notice(`Fixed YAML syntax in: ${file.basename}`);
                            }
                        });
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

        if (orphans.length > 0) {
            const deleteBtn = contentEl.createEl('button', { text: 'Delete All Orphans', cls: 'mod-warning btm-action-btn' });
            deleteBtn.onclick = () => {
                new BtmConfirmationModal(
                    this.app,
                    'Delete All Orphans',
                    `Are you sure you want to delete ${orphans.length} orphaned tags? This will remove them from all files.`,
                    async () => {
                        this.close();
                        const tagsToDelete = orphans.map(o => o.tag);
                        const modifiedCount = await this.plugin.deleteTags(tagsToDelete, true);
                        new Notice(`Successfully deleted ${tagsToDelete.length} orphan tags across ${modifiedCount} files.`);
                    }
                ).open();
            };
        }

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
        this.tagCounts = this.plugin.app.metadataCache.getTags() ?? {};
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
        this.tagCounts = this.plugin.app.metadataCache.getTags() ?? {};
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
    private onConfirm: (folders: string[]) => void | Promise<void>;
    private listEl: HTMLElement;
    private searchInput: TextComponent;

    constructor(app: App, plugin: TagLowercasePlugin, currentFolders: string[], onConfirm: (folders: string[]) => void | Promise<void>) {
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
            const selected = Array.from(this.selectedFolders);
            this.close();
            runAsync(async () => {
                await this.onConfirm(selected);
            });
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

class TagInteractionHandler extends Component {
    plugin: TagLowercasePlugin;
    opts: TagInteractionOptions;

    constructor(plugin: TagLowercasePlugin, opts: TagInteractionOptions) {
        super();
        this.plugin = plugin;
        this.opts = opts;
    }

    onload() {
        const { selector, container, hoverSource, toTag } = this.opts;

        registerDelegatedDomEvent(this, activeDocument, 'mouseover', selector, (event, targetEl) => {
            const tagName = toTag(targetEl);
            const tagPage = tagName ? this.plugin.tagPage(tagName) : undefined;
            if (!tagPage) return;

            this.plugin.app.workspace.trigger('hover-link', {
                event,
                source: hoverSource,
                targetEl,
                linktext: tagPage.path,
                hoverParent: targetEl.closest(container) ?? targetEl,
            });
        });

        if (this.opts.enableContextMenu) {
            registerDelegatedDomEvent(this, activeDocument, 'contextmenu', selector, (event, targetEl) => {
                const tagName = toTag(targetEl);
                if (!tagName) return;

                const mouseEvent = event as MouseEvent;
                if (!this.opts.mergeMenu) {
                    this.plugin.setupTagWranglerMenu(menuForEvent(mouseEvent), tagName);
                    return;
                }

                const menuCtor = Menu as typeof Menu & { forEvent?: (event: MouseEvent) => Menu };
                const originalShowAtPosition = Menu.prototype.showAtPosition;
                const originalForEvent = menuCtor.forEvent;
                const plugin = this.plugin;
                let restored = false;

                const restore = () => {
                    if (restored) return;
                    restored = true;
                    Menu.prototype.showAtPosition = originalShowAtPosition;
                    menuCtor.forEvent = originalForEvent;
                };

                Menu.prototype.showAtPosition = function (...args: Parameters<Menu['showAtPosition']>) {
                    restore();
                    plugin.setupTagWranglerMenu(this, tagName);
                    return originalShowAtPosition.apply(this, args);
                };

                if (originalForEvent) {
                    menuCtor.forEvent = (ev: MouseEvent) => {
                        const menu = originalForEvent.call(menuCtor, ev);
                        if (ev === mouseEvent) {
                            this.plugin.setupTagWranglerMenu(menu, tagName);
                            restore();
                        }
                        return menu;
                    };
                }

                window.setTimeout(restore, 0);
            }, { capture: !!this.opts.mergeMenu });
        }

        if (hoverSource === 'preview') {
            registerDelegatedDomEvent(this, activeDocument, 'dragstart', selector, (event, targetEl) => {
                const dragEvent = event as DragEvent;
                const tagName = toTag(targetEl);
                if (!dragEvent.dataTransfer || !tagName) return;
                const dragManager = getDragManager(this.plugin.app);

                dragEvent.dataTransfer.setData('text/plain', tagName.startsWith('#') ? tagName : `#${tagName}`);
                dragManager?.onDragStart?.(dragEvent, {
                    source: 'bulk-tag-manager',
                    type: 'text',
                    title: tagName.replace(/^#/, ''),
                    icon: 'hashtag',
                });
            });
        }

        registerDelegatedDomEvent(this, activeDocument, hoverSource === 'editor' ? 'mousedown' : 'click', selector, (event, targetEl) => {
            const mouseEvent = event as MouseEvent;
            const isMod = !!Keymap.isModEvent(mouseEvent);
            if (!isMod && !mouseEvent.altKey) return;

            const tagName = toTag(targetEl);
            if (!tagName) return;

            const existingTagPage = this.plugin.tagPage(tagName);
            if (existingTagPage) {
                void this.plugin.openTagPage(existingTagPage, false, isMod);
            } else {
                new TagPageCreateModal(this.plugin.app, this.plugin, tagName.replace(/^#/, ''), isMod).open();
            }

            mouseEvent.preventDefault();
            mouseEvent.stopImmediatePropagation();
        }, { capture: true });
    }
}

class TagRenamePromptModal extends Modal {
    plugin: TagLowercasePlugin;
    tagName: string;

    constructor(app: App, plugin: TagLowercasePlugin, tagName: string) {
        super(app);
        this.plugin = plugin;
        this.tagName = tagName.replace(/^#/, '');
    }

    onOpen() {
        const { contentEl } = this;
        contentEl.empty();

        new Setting(contentEl).setName(`Rename #${this.tagName}`).setHeading();
        const input = new TextComponent(contentEl).setValue(this.tagName).setPlaceholder('new-tag-name');
        input.inputEl.focus();
        input.inputEl.select();

        const actions = contentEl.createDiv({ cls: 'btm-action-row' });
        const cancelBtn = actions.createEl('button', { text: 'Cancel' });
        cancelBtn.onclick = () => this.close();

        const saveBtn = actions.createEl('button', { text: 'Rename', cls: 'mod-cta' });
        saveBtn.onclick = () => {
            runAsync(async () => {
                const nextName = input.getValue().trim().replace(/^#/, '');
                this.close();
                if (!nextName || nextName === this.tagName) {
                    new Notice('Unchanged or empty tag. No changes made.');
                    return;
                }
                await this.plugin.renameTag(this.tagName, nextName);
            });
        };
    }

    onClose() {
        this.contentEl.empty();
    }
}

class TagPageCreateModal extends Modal {
    plugin: TagLowercasePlugin;
    tagName: string;
    openInNewLeaf: boolean;

    constructor(app: App, plugin: TagLowercasePlugin, tagName: string, openInNewLeaf: boolean) {
        super(app);
        this.plugin = plugin;
        this.tagName = tagName;
        this.openInNewLeaf = openInNewLeaf;
    }

    onOpen() {
        const { contentEl } = this;
        contentEl.empty();

        new Setting(contentEl).setName('Create Tag Page').setHeading();
        contentEl.createEl('p', { text: `A tag page for #${this.tagName} does not exist.` });

        const actions = contentEl.createDiv({ cls: 'btm-action-row' });
        const searchBtn = actions.createEl('button', { text: 'Search Instead' });
        searchBtn.onclick = () => {
            const search = getGlobalSearch(this.app);
            search?.openGlobalSearch?.(`tag:#${this.tagName}`);
            this.close();
        };

        const createBtn = actions.createEl('button', { text: 'Create Tag Page', cls: 'mod-cta' });
        createBtn.onclick = () => {
            runAsync(async () => {
                this.close();
                await this.plugin.createTagPage(this.tagName, this.openInNewLeaf);
            });
        };
    }

    onClose() {
        this.contentEl.empty();
    }
}

class BulkManagerSettingsDashboard {
    app: App;
    plugin: TagLowercasePlugin;
    contentEl: HTMLElement;
    statsEl: HTMLElement;
    invalidBlock: HTMLElement;
    invalidContentEl: HTMLElement;
    metricsGrid: HTMLElement;

    constructor(app: App, plugin: TagLowercasePlugin, contentEl: HTMLElement) {
        this.app = app;
        this.plugin = plugin;
        this.contentEl = contentEl;
    }

    render() {
        const contentEl = this.contentEl;
        contentEl.createEl('p', { text: 'Simple tag actions are on the ribbon. Bulk and vault-wide tools live here in settings.' });

        const overviewBox = contentEl.createDiv({ cls: 'btm-section-box' });
        const overviewHeader = overviewBox.createDiv({ cls: 'btm-collapsible-header' });
        overviewHeader.createSpan({ text: 'Overview (Stats)' });
        const arrow = overviewHeader.createSpan({ cls: 'btm-header-arrow' });
        setIcon(arrow, 'chevron-down');
        this.statsEl = overviewBox.createDiv({ cls: 'btm-collapsible-content' });

        this.invalidBlock = contentEl.createDiv({ cls: 'btm-section-box btm-invalid-block' });
        this.invalidBlock.createDiv({ cls: 'btm-collapsible-header' }).createSpan({ text: 'Invalid Tags (Real-time)' });
        this.invalidContentEl = this.invalidBlock.createDiv({ cls: 'btm-invalid-content' });
        void this.updateStats();

        let isExpanded = true;
        overviewHeader.onclick = () => {
            isExpanded = !isExpanded;
            this.statsEl.toggleClass('is-collapsed', !isExpanded);
            arrow.toggleClass('is-collapsed', !isExpanded);
        };

        // --- Tag Rename Options (Grouped) ---
        const renameOptionsBox = contentEl.createDiv({ cls: 'btm-section-box' });
        const renameOptionsHeader = renameOptionsBox.createDiv({ cls: 'btm-collapsible-header' });
        renameOptionsHeader.createSpan({ text: 'Tag Rename Options' });
        const renameOptionsArrow = renameOptionsHeader.createSpan({ cls: 'btm-header-arrow' });
        setIcon(renameOptionsArrow, 'chevron-down');
        
        const renameOptionsContent = renameOptionsBox.createDiv({ cls: 'btm-collapsible-content' });
        
        let isRenameOptionsExpanded = true;
        renameOptionsHeader.onclick = () => {
            isRenameOptionsExpanded = !isRenameOptionsExpanded;
            renameOptionsContent.toggleClass('is-collapsed', !isRenameOptionsExpanded);
            renameOptionsArrow.toggleClass('is-collapsed', !isRenameOptionsExpanded);
        };



        // Sub-section: Batch Rename (table)
        const batchSub = renameOptionsContent.createDiv({ cls: 'btm-subsection-box' });
        batchSub.createEl('h4', { text: 'Rename Tags', attr: { style: 'margin-top: 0; font-size: 1.1em; color: var(--text-accent); opacity: 0.8;' } });
        batchSub.createEl('p', {
            text: 'Rename multiple tags at once. Each row is an independent old → new pair.',
            cls: 'btm-section-desc'
        });

        const batchPairs: { from: TextComponent; to: TextComponent; row: HTMLElement }[] = [];

        const batchTable = batchSub.createDiv({ cls: 'btm-batch-table' });

        const addBatchRow = () => {
            const row = batchTable.createDiv({ cls: 'btm-batch-row' });

            const fromInput = new TextComponent(row).setPlaceholder('#old-tag');
            fromInput.inputEl.addClass('btm-flex-1');
            new InlineTagSuggest(this.app, fromInput.inputEl, row, (tag) => {
                fromInput.setValue(tag);
            });

            row.createSpan({ text: '→', cls: 'btm-batch-arrow' });

            const toInput = new TextComponent(row).setPlaceholder('#new-tag');
            toInput.inputEl.addClass('btm-flex-1');
            new InlineTagSuggest(this.app, toInput.inputEl, row, (tag) => {
                toInput.setValue(tag);
            });

            const removeBtn = row.createEl('button', { cls: 'btm-icon-btn btm-shrink-0' });
            setIcon(removeBtn, 'x');
            removeBtn.onclick = () => {
                const idx = batchPairs.findIndex(p => p.row === row);
                if (idx !== -1) batchPairs.splice(idx, 1);
                row.remove();
            };

            batchPairs.push({ from: fromInput, to: toInput, row });
        };

        addBatchRow();
        addBatchRow();

        const batchControlRow = batchSub.createDiv({ attr: { style: 'display: flex; gap: 8px; align-items: center; justify-content: space-between;' } });

        const addRowBtn = batchControlRow.createEl('button', { text: '+ Add row', cls: 'btm-suggest-btn btm-icon-btn btm-small-center-btn' });
        addRowBtn.onclick = () => addBatchRow();

        const btnBatchRename = batchControlRow.createEl('button', { text: 'Apply', cls: 'mod-cta btm-action-btn' });
        btnBatchRename.onclick = () => {
            const pairs = batchPairs
                .map(p => ({ from: p.from.getValue().trim(), to: p.to.getValue().trim() }))
                .filter(p => p.from && p.to);

            if (pairs.length === 0) {
                new Notice('Please fill at least one rename pair.');
                return;
            }

            new BtmConfirmationModal(
                this.app,
                'Rename Tags',
                `Apply ${pairs.length} rename pair(s) across the vault?`,
                async () => {
                    await this.plugin.renameTagBatch(pairs);
                    batchPairs.length = 0;
                    batchTable.empty();
                    addBatchRow();
                    addBatchRow();
                    void this.updateStats();
                }
            ).open();
        };

        renameOptionsContent.createEl('hr');

        // Sub-section: Rename from CSV
        const csvSub = renameOptionsContent.createDiv({ cls: 'btm-subsection-box' });
        csvSub.createEl('h4', { text: 'Batch Rename from CSV', attr: { style: 'margin-top: 0; font-size: 1.1em; color: var(--text-accent); opacity: 0.8;' } });
        csvSub.createEl('p', {
            text: 'Upload a CSV with columns old_tag,new_tag to rename many tags at once.',
            cls: 'btm-section-desc'
        });

        const csvContainer = csvSub.createDiv({ cls: 'btm-aligned-row' });
        const csvCol = csvContainer.createDiv({ cls: 'btm-field-column' });
        csvCol.setAttr('style', 'grid-column: span 2;');

        const csvFileInput = csvCol.createEl('input', { type: 'file' });
        csvFileInput.accept = '.csv';
        csvFileInput.hide();

        const csvPreview = csvCol.createDiv({ cls: 'btm-csv-preview' });

        let parsedCsvPairs: { from: string; to: string }[] = [];

        csvFileInput.addEventListener('change', () => {
            const file = csvFileInput.files?.[0];
            if (!file) return;

            const reader = new FileReader();
            reader.onload = (e) => {
                const text = e.target?.result as string;
                const lines = text.split('\n');
                parsedCsvPairs = [];
                for (let i = 1; i < lines.length; i++) {
                    const line = lines[i].trim();
                    if (!line) continue;
                    const [from, to] = line.split(',').map(s => s.trim().replace(/^#/, ''));
                    if (from && to) parsedCsvPairs.push({ from, to });
                }
                csvPreview.textContent = `Found ${parsedCsvPairs.length} pairs. Example: ${parsedCsvPairs[0].from} → ${parsedCsvPairs[0].to}`;
            };
            reader.readAsText(file);
        });

        const csvActionCol = csvContainer.createDiv({ cls: 'btm-field-column' });
        const csvBtnRow = csvActionCol.createDiv({ attr: { style: 'display: flex; gap: 8px; align-items: flex-end;' } });
        
        const btnUploadCsv = csvBtnRow.createEl('button', { text: 'Upload CSV', cls: 'btm-action-btn' });
        btnUploadCsv.onclick = () => csvFileInput.click();

        const btnApplyCsv = csvBtnRow.createEl('button', { text: 'Apply', cls: 'mod-cta btm-action-btn' });
        btnApplyCsv.onclick = () => {
            if (parsedCsvPairs.length === 0) {
                new Notice('Please upload a valid CSV first.');
                return;
            }
            new BtmConfirmationModal(
                this.app,
                'Batch Rename from CSV',
                `Rename ${parsedCsvPairs.length} tags from CSV?`,
                async () => {
                    await this.plugin.renameTagBatch(parsedCsvPairs);
                    parsedCsvPairs = [];
                    csvPreview.textContent = '';
                    csvFileInput.value = '';
                    void this.updateStats();
                }
            ).open();
        };

        // --- Original Merge and Search Sections (keep them as they were) ---
        const mergeBox = contentEl.createDiv({ cls: 'btm-section-box' });
        mergeBox.createDiv({ cls: 'btm-collapsible-header' }).createSpan({ text: 'Merge Tags' });
        const mergeContainer = mergeBox.createDiv({ cls: 'btm-aligned-row' });
        const sourceCol = mergeContainer.createDiv({ cls: 'btm-field-column' });
        sourceCol.createEl('label', { text: 'Source tags' });
        const mergeSourcesInput = new TextComponent(sourceCol).setPlaceholder('#tag1, #tag2');
        const selectTagsBtn = sourceCol.createEl('button', { cls: 'btm-suggest-btn btm-icon-btn btm-small-center-btn' });
        setIcon(selectTagsBtn, 'list-filter');
        selectTagsBtn.createSpan({ text: ' Select' });
        selectTagsBtn.onclick = () => new MultiTagSelectModal(this.app, this.plugin, (tags) => {
            mergeSourcesInput.setValue(tags.map((tag) => `#${tag}`).join(', '));
        }).open();

        const targetCol = mergeContainer.createDiv({ cls: 'btm-field-column' });
        targetCol.createEl('label', { text: 'Target' });
        const mergeTargetInput = new TextComponent(targetCol).setPlaceholder('#merged');
        const targetSuggestBtn = targetCol.createEl('button', { cls: 'btm-suggest-btn btm-icon-btn btm-small-center-btn' });
        setIcon(targetSuggestBtn, 'search');
        targetSuggestBtn.createSpan({ text: ' Search' });
        targetSuggestBtn.onclick = () => new TagSuggest(this.app, this.plugin, (tag) => {
            mergeTargetInput.setValue(tag);
            mergeTargetInput.inputEl.dispatchEvent(new Event('input'));
        }).open();
        new InlineTagSuggest(this.app, mergeTargetInput.inputEl, targetCol, (tag) => {
            mergeTargetInput.setValue(tag);
            mergeTargetInput.inputEl.dispatchEvent(new Event('input'));
        });

        const mergeActionCol = mergeContainer.createDiv({ cls: 'btm-field-column' });
        const btnMerge = mergeActionCol.createEl('button', { text: 'Merge', cls: 'mod-cta btm-action-btn' });
        btnMerge.onclick = () => {
            const sources = mergeSourcesInput.getValue().split(',').map((part) => part.trim()).filter(Boolean);
            const target = mergeTargetInput.getValue().trim();
            if (!sources.length || !target) {
                new Notice('Please provide source tags and a target.');
                return;
            }
            new BtmConfirmationModal(
                this.app,
                'Merge Tags',
                `Merge ${sources.length} source tags into "${target}"?`,
                async () => {
                    await this.plugin.mergeTags(sources, target);
                    void this.updateStats();
                },
            ).open();
        };

        // --- Nest Tags Section ---
        const nestBox = contentEl.createDiv({ cls: 'btm-section-box' });
        nestBox.createDiv({ cls: 'btm-collapsible-header' }).createSpan({ text: 'Nest Tags' });
        const nestContainer = nestBox.createDiv({ cls: 'btm-aligned-row' });

        const nestParentCol = nestContainer.createDiv({ cls: 'btm-field-column' });
        nestParentCol.createEl('label', { text: 'Parent tag' });
        const nestParentInput = new TextComponent(nestParentCol).setPlaceholder('#parent (e.g. enfermedades)');
        const nestParentSuggestBtn = nestParentCol.createEl('button', { cls: 'btm-suggest-btn btm-icon-btn btm-small-center-btn' });
        setIcon(nestParentSuggestBtn, 'search');
        nestParentSuggestBtn.createSpan({ text: ' Search' });
        nestParentSuggestBtn.onclick = () => new TagSuggest(this.app, this.plugin, (tag) => {
            nestParentInput.setValue(tag);
        }).open();
        new InlineTagSuggest(this.app, nestParentInput.inputEl, nestParentCol, (tag) => {
            nestParentInput.setValue(tag);
        });

        const nestChildCol = nestContainer.createDiv({ cls: 'btm-field-column' });
        nestChildCol.createEl('label', { text: 'Tags to nest' });
        const nestChildInput = new TextComponent(nestChildCol).setPlaceholder('#tag1, #tag2, #tag3');
        const nestSelectBtn = nestChildCol.createEl('button', { cls: 'btm-suggest-btn btm-icon-btn btm-small-center-btn' });
        setIcon(nestSelectBtn, 'list-filter');
        nestSelectBtn.createSpan({ text: ' Select' });
        nestSelectBtn.onclick = () => new MultiTagSelectModal(this.app, this.plugin, (tags) => {
            nestChildInput.setValue(tags.map((tag) => `#${tag}`).join(', '));
        }).open();

        const nestActionCol = nestContainer.createDiv({ cls: 'btm-field-column' });
        const btnNest = nestActionCol.createEl('button', { text: 'Nest', cls: 'mod-cta btm-action-btn' });
        btnNest.onclick = () => {
            const parent = nestParentInput.getValue().trim();
            const children = nestChildInput.getValue().split(',').map((part) => part.trim()).filter(Boolean);
            if (!parent || !children.length) {
                new Notice('Please provide a parent tag and at least one child tag.');
                return;
            }
            const parentClean = parent.replace(/^#/, '');
            new BtmConfirmationModal(
                this.app,
                'Nest Tags',
                `Nest ${children.length} tag(s) under "#${parentClean}"? Each tag will be renamed to #${parentClean}/tagname.`,
                async () => {
                    await this.plugin.nestTags(parent, children);
                    void this.updateStats();
                },
            ).open();
        };



        const deleteBox = contentEl.createDiv({ cls: 'btm-section-box' });
        deleteBox.createDiv({ cls: 'btm-collapsible-header' }).createSpan({ text: 'Delete Tags' });
        const deleteContainer = deleteBox.createDiv({ cls: 'btm-aligned-row' });
        const deleteCol = deleteContainer.createDiv({ cls: 'btm-field-column' });
        deleteCol.setAttr('style', 'grid-column: span 2;');
        deleteCol.createEl('label', { text: 'Tags to Delete (comma separated)' });
        const deleteInput = new TextComponent(deleteCol).setPlaceholder('#bad-tag, #unused');
        deleteInput.inputEl.addClass('btm-full-width-input');
        const delBtnRow = deleteCol.createDiv({ attr: { style: 'display: flex; gap: 8px;' } });
        const delSelectBtn = delBtnRow.createEl('button', { cls: 'btm-suggest-btn btm-icon-btn btm-small-center-btn' });
        setIcon(delSelectBtn, 'list-filter');
        delSelectBtn.createSpan({ text: ' Select' });
        delSelectBtn.onclick = () => new MultiTagSelectModal(this.app, this.plugin, (tags) => {
            deleteInput.setValue(tags.map((tag) => `#${tag}`).join(', '));
        }).open();
        const delSearchBtn = delBtnRow.createEl('button', { cls: 'btm-suggest-btn btm-icon-btn btm-small-center-btn' });
        setIcon(delSearchBtn, 'search');
        delSearchBtn.createSpan({ text: ' Search' });
        delSearchBtn.onclick = () => new TagSuggest(this.app, this.plugin, (tag) => {
            const current = deleteInput.getValue();
            deleteInput.setValue(current ? `${current}, #${tag}` : `#${tag}`);
        }).open();

        const btnDelete = deleteContainer.createEl('button', { text: 'Delete', cls: 'mod-warning btm-action-btn' });
        btnDelete.onclick = () => {
            const tagsToDelete = deleteInput.getValue().split(',').map((part) => part.trim()).filter(Boolean);
            if (!tagsToDelete.length) {
                new Notice('Please provide tags to delete.');
                return;
            }
            new BtmConfirmationModal(
                this.app,
                'Delete Tags',
                `Delete ${tagsToDelete.length} tags across the vault?`,
                async () => {
                    await this.plugin.deleteTags(tagsToDelete);
                    void this.updateStats();
                },
            ).open();
        };

        deleteBox.createEl('hr');

        // Sub-section: Delete from List
        const deleteListSub = deleteBox.createDiv({ cls: 'btm-subsection-box' });
        deleteListSub.createEl('h4', { text: 'Delete from List', attr: { style: 'margin-top: 0; font-size: 1.1em; color: var(--text-accent); opacity: 0.8;' } });
        deleteListSub.createEl('p', {
            text: 'Upload a plain text file with one tag per line to delete many tags at once.',
            cls: 'btm-section-desc'
        });

        const deleteListFileInput = deleteListSub.createEl('input', { type: 'file' });
        deleteListFileInput.accept = '.txt,.csv';
        deleteListFileInput.hide();

        const deleteListPreview = deleteListSub.createDiv({ cls: 'btm-scroll-preview' });

        let parsedDeleteTags: string[] = [];

        deleteListFileInput.addEventListener('change', () => {
            const file = deleteListFileInput.files?.[0];
            if (!file) return;
            const reader = new FileReader();
            reader.onload = (e) => {
                const text = e.target?.result as string;
                parsedDeleteTags = parseTagDeleteList(text);
                deleteListPreview.empty();
                if (parsedDeleteTags.length === 0) {
                    deleteListPreview.createSpan({ text: 'No valid tags found in file.' });
                    return;
                }
                deleteListPreview.createSpan({ text: `${parsedDeleteTags.length} tags loaded:` });
                const previewList = deleteListPreview.createEl('ul', { attr: { style: 'margin: 4px 0; padding-left: 16px;' } });
                parsedDeleteTags.slice(0, 8).forEach(t => {
                    previewList.createEl('li', { text: `#${t}` });
                });
                if (parsedDeleteTags.length > 8) {
                    previewList.createEl('li', { text: `... and ${parsedDeleteTags.length - 8} more` });
                }
            };
            reader.readAsText(file, 'UTF-8');
        });

        const deleteListBtnRow = deleteListSub.createDiv({ attr: { style: 'display: flex; gap: 8px; align-items: center; justify-content: space-between; margin-top: 8px;' } });

        const chooseDeleteListBtn = deleteListBtnRow.createEl('button', { text: 'Choose file', cls: 'btm-suggest-btn btm-icon-btn btm-small-center-btn' });
        setIcon(chooseDeleteListBtn, 'upload');
        chooseDeleteListBtn.onclick = () => deleteListFileInput.click();

        const applyDeleteListBtn = deleteListBtnRow.createEl('button', { text: 'Delete All', cls: 'mod-warning btm-action-btn' });
        applyDeleteListBtn.onclick = () => {
            if (parsedDeleteTags.length === 0) {
                new Notice('Please load a file first.');
                return;
            }
            new BtmConfirmationModal(
                this.app,
                'Delete from List',
                `Permanently delete ${parsedDeleteTags.length} tag(s) from the vault? This cannot be undone without using the undo history.`,
                async () => {
                    await this.plugin.deleteTags(parsedDeleteTags);
                    deleteListPreview.empty();
                    parsedDeleteTags = [];
                    deleteListFileInput.value = '';
                    void this.updateStats();
                }
            ).open();
        };


        const patternBox = contentEl.createDiv({ cls: 'btm-section-box' });
        patternBox.createDiv({ cls: 'btm-collapsible-header' }).createSpan({ text: 'Pattern Rename (Regex)' });
        const patternContainer = patternBox.createDiv({ cls: 'btm-aligned-row' });
        const patternCol = patternContainer.createDiv({ cls: 'btm-field-column' });
        patternCol.createEl('label', { text: 'Pattern' });
        const patternInput = new TextComponent(patternCol).setPlaceholder('^old-(.*)');
        const patternRepCol = patternContainer.createDiv({ cls: 'btm-field-column' });
        patternRepCol.createEl('label', { text: 'Replacement' });
        const patternReplaceInput = new TextComponent(patternRepCol).setPlaceholder('new-$1');
        const btnPattern = patternContainer.createEl('button', { text: 'Apply', cls: 'mod-cta btm-action-btn' });
        btnPattern.onclick = () => {
            const pattern = patternInput.getValue();
            if (!pattern) {
                new Notice('Please provide a pattern.');
                return;
            }
            new BtmConfirmationModal(
                this.app,
                'Pattern Rename',
                `Apply the regex pattern "${pattern}" across matching tags?`,
                async () => {
                    await this.plugin.batchRename(pattern, patternReplaceInput.getValue());
                    void this.updateStats();
                },
            ).open();
        };

        const settingsBox = contentEl.createDiv({ cls: 'btm-section-box' });
        settingsBox.createDiv({ cls: 'btm-collapsible-header' }).createSpan({ text: 'Bulk Settings' });
        new Setting(settingsBox)
            .setName('Case Strategy')
            .addDropdown((dropdown) => dropdown
                .addOption('lowercase', 'Lowercase')
                .addOption('uppercase', 'Uppercase')
                .addOption('none', 'No Change')
                .setValue(this.plugin.settings.caseStrategy)
                .onChange((value: TagLowercaseSettings['caseStrategy']) => {
                    runAsync(async () => {
                        this.plugin.settings.caseStrategy = value;
                        await this.plugin.saveSettings();
                        void this.updateStats();
                    });
                }));
        new Setting(settingsBox)
            .setName('Separator Style')
            .addDropdown((dropdown) => dropdown
                .addOption('preserve', 'Preserve')
                .addOption('snake', 'Snake Case')
                .addOption('kebab', 'Kebab Case')
                .setValue(this.plugin.settings.separatorStrategy)
                .onChange((value: TagLowercaseSettings['separatorStrategy']) => {
                    runAsync(async () => {
                        this.plugin.settings.separatorStrategy = value;
                        await this.plugin.saveSettings();
                        void this.updateStats();
                    });
                }));
        new Setting(settingsBox)
            .setName('Remove Special Characters')
            .setDesc('Removes everything except letters, numbers, hyphens (-), and underscores (_).')
            .addToggle((toggle) => toggle
                .setValue(this.plugin.settings.removeSpecialChars)
                .onChange((value) => {
                    runAsync(async () => {
                        this.plugin.settings.removeSpecialChars = value;
                        await this.plugin.saveSettings();
                        void this.updateStats();
                    });
                }));
        new Setting(settingsBox)
            .setName('Flatten Diacritics')
            .setDesc('Converts accented characters to their plain equivalents.')
            .addToggle((toggle) => toggle
                .setValue(this.plugin.settings.flattenDiacritics)
                .onChange((value) => {
                    runAsync(async () => {
                        this.plugin.settings.flattenDiacritics = value;
                        await this.plugin.saveSettings();
                        void this.updateStats();
                    });
                }));
        new Setting(settingsBox)
            .setName('Apply to Nested Tags')
            .addToggle((toggle) => toggle
                .setValue(this.plugin.settings.applyToNestedTags)
                .onChange((value) => {
                    runAsync(async () => {
                        this.plugin.settings.applyToNestedTags = value;
                        await this.plugin.saveSettings();
                        void this.updateStats();
                    });
                }));
        new Setting(settingsBox)
            .setName('Enable Scope Filter')
            .setDesc('Limit operations to specific folders')
            .addToggle((toggle) => toggle
                .setValue(this.plugin.settings.scopeFilter.enabled)
                .onChange((value) => {
                    runAsync(async () => {
                        this.plugin.settings.scopeFilter.enabled = value;
                        await this.plugin.saveSettings();
                        void this.updateStats();
                    });
                }));

        new Setting(settingsBox)
            .setName('File Pattern Filter')
            .setDesc('Optional regex applied to file paths when the scope filter is enabled.')
            .addText((text) => text
                .setPlaceholder('^Projects/')
                .setValue(this.plugin.settings.scopeFilter.filePattern)
                .onChange((value) => {
                    runAsync(async () => {
                        this.plugin.settings.scopeFilter.filePattern = value.trim();
                        await this.plugin.saveSettings();
                        void this.updateStats();
                    });
                }));

        const scopeContainer = settingsBox.createDiv({ cls: 'btm-scope-container' });
        const includeCol = scopeContainer.createDiv({ cls: 'btm-field-column' });
        includeCol.createEl('label', { text: 'Include Folders' });
        const includeRow = includeCol.createDiv({ cls: 'btm-scope-input-row' });
        const includeDisplay = includeRow.createDiv({ text: this.plugin.settings.scopeFilter.includeFolders.join(', ') || '(all)', cls: 'btm-folder-input-display' });
        const includeBtn = includeRow.createEl('button', { cls: 'btm-suggest-btn btm-icon-btn btm-small-center-btn' });
        setIcon(includeBtn, 'folder-plus');
        includeBtn.onclick = () => new FolderSelectModal(this.app, this.plugin, this.plugin.settings.scopeFilter.includeFolders, async (folders) => {
            this.plugin.settings.scopeFilter.includeFolders = folders;
            await this.plugin.saveSettings();
            includeDisplay.textContent = folders.join(', ') || '(all)';
            void this.updateStats();
        }).open();

        const excludeCol = scopeContainer.createDiv({ cls: 'btm-field-column' });
        excludeCol.createEl('label', { text: 'Exclude Folders' });
        const excludeRow = excludeCol.createDiv({ cls: 'btm-scope-input-row' });
        const excludeDisplay = excludeRow.createDiv({ text: this.plugin.settings.scopeFilter.excludeFolders.join(', ') || '(none)', cls: 'btm-folder-input-display' });
        const excludeBtn = excludeRow.createEl('button', { cls: 'btm-suggest-btn btm-icon-btn btm-small-center-btn' });
        setIcon(excludeBtn, 'folder-minus');
        excludeBtn.onclick = () => new FolderSelectModal(this.app, this.plugin, this.plugin.settings.scopeFilter.excludeFolders, async (folders) => {
            this.plugin.settings.scopeFilter.excludeFolders = folders;
            await this.plugin.saveSettings();
            excludeDisplay.textContent = folders.join(', ') || '(none)';
            void this.updateStats();
        }).open();

        const bulkActionRow = settingsBox.createDiv({ cls: 'btm-action-row' });
        const convertBtn = this.createIconButton(bulkActionRow, 'refresh-cw', 'Convert All', 'mod-cta');
        convertBtn.onclick = () => {
            runAsync(async () => {
                await this.plugin.runConversionWithPreview();
                void this.updateStats();
            });
        };

        const utilBox = contentEl.createDiv({ cls: 'btm-section-box' });
        utilBox.createDiv({ cls: 'btm-collapsible-header' }).createSpan({ text: 'Metadata Utilities' });
        const utilRow = utilBox.createDiv({ cls: 'btm-util-column' });
        const btnClean = this.createIconButton(utilRow, 'file-check', 'Clean front matter formatting');
        setTooltip(btnClean, 'Remove unnecessary quotes and trim whitespace from all frontmatter fields');
        btnClean.onclick = () => void this.plugin.standardiseProperties();
        const btnAllInline = this.createIconButton(utilRow, 'list-plus', 'Standardise to Inline Array');
        btnAllInline.onclick = () => {
            const files = this.plugin.getFilteredFiles();
            new BtmConfirmationModal(
                this.app,
                'Standardise to Inline Array',
                `Convert tags and wiki links to inline arrays across ${files.length} files?`,
                async () => {
                    await this.plugin.convertTagFormat(files, 'inline', true);
                    await this.plugin.convertWikiLinkFormat(files, 'inline', true);
                    void this.updateStats();
                },
            ).open();
        };
        const btnAllList = this.createIconButton(utilRow, 'list-minus', 'Standardise to YAML List');
        btnAllList.onclick = () => {
            const files = this.plugin.getFilteredFiles();
            new BtmConfirmationModal(
                this.app,
                'Standardise to YAML List',
                `Convert tags and wiki links to YAML lists across ${files.length} files?`,
                async () => {
                    await this.plugin.convertTagFormat(files, 'list', true);
                    await this.plugin.convertWikiLinkFormat(files, 'list', true);
                    void this.updateStats();
                },
            ).open();
        };

        const actionBox = contentEl.createDiv({ cls: 'btm-section-box' });
        actionBox.createDiv({ cls: 'btm-collapsible-header' }).createSpan({ text: 'Other Actions' });
        const actionRowBottom = actionBox.createDiv({ cls: 'btm-action-row' });
        this.createActionButton(actionRowBottom, 'list', 'Tag List', async () => this.plugin.generateTagList());
        this.createActionButton(actionRowBottom, 'git-branch', 'Tag Nesting', () => new TagHierarchyModal(this.app, this.plugin).open());
        this.createActionButton(actionRowBottom, 'alert-circle', 'Orphans', () => new OrphanTagsModal(this.app, this.plugin).open());
        this.createActionButton(actionRowBottom, 'history', 'History', () => new HistoryModal(this.app, this.plugin).open());
    }

    createActionButton(container: HTMLElement, icon: string, text: string, action: () => void | Promise<void>) {
        const button = this.createIconButton(container, icon, text);
        button.onclick = () => void action();
    }

    createIconButton(container: HTMLElement, iconName: string, text: string, cls = '') {
        const btn = container.createEl('button', { cls: `btm-icon-btn ${cls}`.trim() });
        const iconEl = btn.createSpan({ cls: 'btm-btn-icon' });
        setIcon(iconEl, iconName);
        btn.createSpan({ text: ` ${text}` });
        return btn;
    }

    createProgressBar(container: HTMLElement, value: number) {
        const bar = container.createDiv({ cls: 'btm-progress-bar-mini' });
        const fill = bar.createDiv({ cls: 'btm-progress-fill-mini' });
        fill.setCssProps({ width: `${value}%` });
        if (value < 50) fill.addClass('btm-progress-low');
        else if (value < 80) fill.addClass('btm-progress-medium');
        else fill.addClass('btm-progress-high');
    }

    async updateStats() {
        const files = this.plugin.getFilteredFiles();
        if (this.statsEl.childElementCount === 0) {
            this.statsEl.createDiv({ text: 'Loading stats...', cls: 'btm-loading' });
        }

        const stats = await this.plugin.analyzeTagStandardization(files);
        this.statsEl.empty();
        this.statsEl.addClass('btm-standardization-panel');

        const headerRow = this.statsEl.createDiv({ cls: 'btm-stats-header' });
        const tagsItem = headerRow.createSpan({ cls: 'btm-stat-item' });
        setIcon(tagsItem.createSpan({ cls: 'btm-stat-icon' }), 'tags');
        tagsItem.createSpan({ text: ` ${stats.totalTags} tags` });
        const filesItem = headerRow.createSpan({ cls: 'btm-stat-item' });
        setIcon(filesItem.createSpan({ cls: 'btm-stat-icon' }), 'files');
        filesItem.createSpan({ text: ` ${files.length} files` });

        this.metricsGrid = this.statsEl.createDiv({ cls: 'btm-metrics-grid' });
        const addMetricLink = (container: HTMLElement, count: number, label: string, tags: string[]) => {
            if (count > 0) {
                const link = container.createEl('a', { text: `${count} ${label}`, cls: 'btm-stat-link' });
                link.onclick = () => new TagListModal(this.app, `${label} Tags`, tags).open();
                container.appendText(' ');
            }
        };

        const caseBox = this.metricsGrid.createDiv({ cls: 'btm-metric-box' });
        caseBox.createDiv({ text: 'Case', cls: 'btm-metric-label' });
        this.createProgressBar(caseBox, stats.caseStats.consistency);
        const caseDetails = caseBox.createDiv({ cls: 'btm-metric-details' });
        addMetricLink(caseDetails, stats.caseStats.lowercase.length, 'lower', stats.caseStats.lowercase);
        addMetricLink(caseDetails, stats.caseStats.uppercase.length, 'UPPER', stats.caseStats.uppercase);
        addMetricLink(caseDetails, stats.caseStats.mixed.length, 'Mixed', stats.caseStats.mixed);

        const caseButtons = caseBox.createDiv({ cls: 'btm-inline-case-btns' });
        const btnUpper = caseButtons.createEl('button', { text: 'Convert to upper', cls: 'btm-mini-case-btn' });
        btnUpper.onclick = () => {
            new BtmConfirmationModal(
                this.app,
                'Bulk Convert to UPPERCASE',
                'Are you sure you want to convert ALL tags in your vault to UPPERCASE? This action will modify multiple files.',
                async () => {
                    await this.plugin.convertAllToCase('uppercase');
                    this.updateStats().catch((e) => console.error('Failed to update stats', e));
                },
            ).open();
        };
        const btnLower = caseButtons.createEl('button', { text: 'Convert to lower', cls: 'btm-mini-case-btn' });
        btnLower.onclick = () => {
            new BtmConfirmationModal(
                this.app,
                'Bulk Convert to lowercase',
                'Are you sure you want to convert ALL tags in your vault to lowercase? This action will modify multiple files.',
                async () => {
                    await this.plugin.convertAllToCase('lowercase');
                    this.updateStats().catch((e) => console.error('Failed to update stats', e));
                },
            ).open();
        };

        const sepBox = this.metricsGrid.createDiv({ cls: 'btm-metric-box' });
        sepBox.createDiv({ text: 'Separators', cls: 'btm-metric-label' });
        this.createProgressBar(sepBox, stats.separatorStats.consistency);
        const sepDetails = sepBox.createDiv({ cls: 'btm-metric-details' });
        addMetricLink(sepDetails, stats.separatorStats.hyphen.length, 'kebab-case', stats.separatorStats.hyphen);
        addMetricLink(sepDetails, stats.separatorStats.underscore.length, 'snake_case', stats.separatorStats.underscore);
        addMetricLink(sepDetails, stats.separatorStats.both.length, 'mixed', stats.separatorStats.both);
        addMetricLink(sepDetails, stats.separatorStats.none.length, 'none', stats.separatorStats.none);

        const specialBox = this.metricsGrid.createDiv({ cls: 'btm-metric-box' });
        specialBox.createDiv({ text: 'Clean tags and front matter', cls: 'btm-metric-label' });
        this.createProgressBar(specialBox, stats.specialCharStats.consistency);
        const specialDetails = specialBox.createDiv({ cls: 'btm-metric-details' });
        addMetricLink(specialDetails, stats.specialCharStats.clean.length, 'clean tags', stats.specialCharStats.clean);
        addMetricLink(specialDetails, stats.specialCharStats.withSpecial.length, 'with special chars', stats.specialCharStats.withSpecial);

        if (stats.quotedFrontmatterCount > 0) {
            const fmLink = specialDetails.createEl('a', {
                text: `${stats.quotedFrontmatterCount} notes with quoted properties`,
                cls: 'btm-stat-link btm-warning-link',
            });
            fmLink.onclick = () => new SimpleFileListModal(this.app, 'Notes with Quoted Properties', stats.quotedFrontmatterFiles).open();
        }

        const formatBox = this.metricsGrid.createDiv({ cls: 'btm-metric-box' });
        formatBox.createDiv({ text: 'Tag Format Style', cls: 'btm-metric-label' });

        const formatContent = formatBox.createDiv({ cls: 'btm-metric-details', attr: { style: 'display:block; margin-bottom: 5px;' } });
        const createFormatLink = (label: string, tagFiles: TFile[]) => {
            if (tagFiles.length > 0) {
                const link = formatContent.createEl('a', { text: `${label}: ${tagFiles.length} files`, cls: 'btm-stat-link', attr: { style: 'display:block;' } });
                link.onclick = () => new SimpleFileListModal(this.app, label, tagFiles).open();
            } else {
                formatContent.createDiv({ text: `${label}: 0 files`, attr: { style: 'color: var(--text-muted); font-size: var(--font-ui-smaller);' } });
            }
        };

        createFormatLink('YAML List', stats.formatStats.yamlList);
        createFormatLink('Inline Array', stats.formatStats.inlineArray);

        const formatActions = formatBox.createDiv({ cls: 'btm-format-actions', attr: { style: 'margin-top: auto; display: flex; flex-direction: column; gap: 4px;' } });
        const btnToInline = formatActions.createEl('button', { text: 'Convert All to Inline', cls: 'btm-small-btn' });
        btnToInline.onclick = () => {
            new BtmConfirmationModal(
                this.app,
                'Convert to Inline Array',
                'Are you sure you want to convert ALL tags in these files to the [tag1, tag2] inline format?',
                async () => {
                    await this.plugin.convertTagFormat(files, 'inline');
                    this.updateStats().catch((e) => console.error('Failed to update stats', e));
                },
            ).open();
        };

        const btnToList = formatActions.createEl('button', { text: 'Convert All to List', cls: 'btm-small-btn' });
        btnToList.onclick = () => {
            new BtmConfirmationModal(
                this.app,
                'Convert to YAML List',
                'Are you sure you want to convert ALL tags in these files to the YAML list format?',
                async () => {
                    await this.plugin.convertTagFormat(files, 'list');
                    this.updateStats().catch((e) => console.error('Failed to update stats', e));
                },
            ).open();
        };

        const nestBox = this.metricsGrid.createDiv({ cls: 'btm-metric-box' });
        nestBox.createDiv({ text: 'Tag Nesting', cls: 'btm-metric-label' });
        const nestDetails = nestBox.createDiv({ cls: 'btm-metric-details' });
        if (stats.nestedFiles.length > 0) {
            addMetricLink(nestDetails, stats.nestingStats.flat.length, 'flat', stats.nestingStats.flat);
            const nestedLink = nestDetails.createEl('a', { text: `${stats.nestedFiles.length} notes with nested tags`, cls: 'btm-stat-link' });
            nestedLink.onclick = () => new NestedFilesModal(this.app, stats.nestedFiles).open();
        } else {
            nestDetails.createSpan({ text: '0 notes with nested tags' });
        }

        const locBox = this.metricsGrid.createDiv({ cls: 'btm-metric-box' });
        locBox.createDiv({ text: 'Locations', cls: 'btm-metric-label' });
        const locDetails = locBox.createDiv({ cls: 'btm-metric-details' });
        addMetricLink(locDetails, stats.locationStats.frontmatter.length, 'frontmatter', stats.locationStats.frontmatter);
        addMetricLink(locDetails, stats.locationStats.body.length, 'body', stats.locationStats.body);

        const wikiBox = this.metricsGrid.createDiv({ cls: 'btm-metric-box' });
        wikiBox.createDiv({ text: 'Wiki Link Format Style', cls: 'btm-metric-label' });

        const wikiContent = wikiBox.createDiv({ cls: 'btm-metric-details', attr: { style: 'display:block; margin-bottom: 5px;' } });
        const createWikiLinkStats = (label: string, wikiFiles: TFile[]) => {
            if (wikiFiles.length > 0) {
                const link = wikiContent.createEl('a', { text: `${label}: ${wikiFiles.length} files`, cls: 'btm-stat-link', attr: { style: 'display:block;' } });
                link.onclick = () => new SimpleFileListModal(this.app, label, wikiFiles).open();
            } else {
                wikiContent.createDiv({ text: `${label}: 0 files`, attr: { style: 'color: var(--text-muted); font-size: var(--font-ui-smaller);' } });
            }
        };

        createWikiLinkStats('YAML List', stats.wikiLinkStats.yamlList);
        createWikiLinkStats('Inline Array', stats.wikiLinkStats.inlineArray);

        const wikiActions = wikiBox.createDiv({ cls: 'btm-format-actions', attr: { style: 'margin-top: auto; display: flex; flex-direction: column; gap: 4px;' } });
        const btnWikiToInline = wikiActions.createEl('button', { text: 'Convert All to Inline', cls: 'btm-small-btn' });
        btnWikiToInline.onclick = () => {
            new BtmConfirmationModal(
                this.app,
                'Convert Wiki Links to Inline Array',
                'Are you sure you want to convert ALL wiki link properties to the ["[[Link]]"] inline format?',
                async () => {
                    await this.plugin.convertWikiLinkFormat(files, 'inline');
                    this.updateStats().catch((e) => console.error('Failed to update stats', e));
                },
            ).open();
        };

        const btnWikiToList = wikiActions.createEl('button', { text: 'Convert All to List', cls: 'btm-small-btn' });
        btnWikiToList.onclick = () => {
            new BtmConfirmationModal(
                this.app,
                'Convert Wiki Links to YAML List',
                'Are you sure you want to convert ALL wiki link properties to the YAML list format?',
                async () => {
                    await this.plugin.convertWikiLinkFormat(files, 'list');
                    this.updateStats().catch((e) => console.error('Failed to update stats', e));
                },
            ).open();
        };

        if (stats.inlineFiles.length > 0) {
            locBox.createDiv({ cls: 'btm-separator' });
            const inlineLink = locBox.createEl('a', {
                text: `${stats.inlineFiles.length} notes with tags in body`,
                cls: 'btm-stat-link',
                attr: { style: 'display:block; margin-top:4px;' },
            });
            inlineLink.onclick = () => new InlineTagsModal(this.app, stats.inlineFiles).open();
        }

        const lengthBox = this.metricsGrid.createDiv({ cls: 'btm-metric-box' });
        lengthBox.createDiv({ text: 'Length', cls: 'btm-metric-label' });
        const lengthDetails = lengthBox.createDiv({ cls: 'btm-metric-details' });
        addMetricLink(lengthDetails, stats.lengthStats.long.length, 'long (>25)', stats.lengthStats.long);

        if (stats.caseDuplicates.length > 0) {
            const dupBox = this.metricsGrid.createDiv({ cls: 'btm-metric-box' });
            dupBox.createDiv({ text: 'Potential Case Duplicates', cls: 'btm-metric-label' });
            const dupDetails = dupBox.createDiv({ cls: 'btm-metric-details' });

            const dupLink = dupDetails.createEl('a', {
                text: `${stats.caseDuplicates.length} pairs of duplicate tags`,
                cls: 'btm-stat-link btm-warning-link',
            });
            dupLink.onclick = () => {
                new TagListModal(this.app, 'Case Duplicates', stats.caseDuplicates.flatMap((d) => d.variants)).open();
            };

            const mergeAllBtn = dupBox.createEl('button', { text: 'Merge all to canonical', cls: 'btm-small-btn btm-warning-btn', attr: { style: 'margin-top: auto;' } });
            setTooltip(mergeAllBtn, 'Merge all case variants into their most-used versions');
            mergeAllBtn.onclick = () => {
                new BtmConfirmationModal(
                    this.app,
                    'Merge Case Duplicates',
                    `Are you sure you want to merge ${stats.caseDuplicates.length} sets of case-variant tags? This will unify them using their most-used versions.`,
                    async () => {
                        const progressModal = new ProgressModal(this.app, stats.caseDuplicates.length);
                        progressModal.open();

                        let i = 0;
                        for (const { canonical, variants } of stats.caseDuplicates) {
                            const sources = variants.filter((v) => v !== canonical);
                            await this.plugin.mergeTags(sources, canonical);
                            i++;
                            progressModal.update(i);
                        }

                        progressModal.close();
                        new Notice('Finished merging case duplicates.');
                        this.updateStats().catch((e) => console.error('Failed to update stats', e));
                    },
                ).open();
            };
        }

        await this.checkInvalidTags();
        await this.checkEmptyTags();
    }

    async checkInvalidTags() {
        this.invalidContentEl.empty();
        const invalidFiles = await this.plugin.findInvalidTagFormats();
        if (!invalidFiles.length) {
            this.invalidBlock.hide();
            return;
        }

        this.invalidBlock.show();
        const warningRow = this.invalidContentEl.createDiv({ cls: 'btm-invalid-warning' });
        const iconEl = warningRow.createSpan({ cls: 'btm-icon' });
        setIcon(iconEl, 'alert-triangle');
        warningRow.createSpan({ text: ` ${invalidFiles.length} file${invalidFiles.length > 1 ? 's' : ''} with invalid tags` });
        const fixBtn = warningRow.createEl('button', { text: 'Fix Invalid', cls: 'mod-warning btm-fix-invalid-btn' });
        fixBtn.onclick = () => new InvalidTagsModal(this.app, this.plugin, invalidFiles).open();

        const list = this.invalidContentEl.createDiv({ cls: 'btm-invalid-mini-list' });
        invalidFiles.slice(0, 3).forEach((file) => list.createDiv({ text: file.path, cls: 'btm-invalid-mini-item' }));
        if (invalidFiles.length > 3) {
            list.createDiv({ text: `... and ${invalidFiles.length - 3} more`, cls: 'btm-more' });
        }
    }

    async checkEmptyTags() {
        const emptyFiles = await this.plugin.findEmptyTags();
        if (emptyFiles.length > 0 && this.metricsGrid) {
            const emptyBox = this.metricsGrid.createDiv({ cls: 'btm-metric-box btm-info-box' });
            emptyBox.createDiv({ text: 'Empty Tags', cls: 'btm-metric-label' });
            const detail = emptyBox.createDiv({ cls: 'btm-metric-details' });
            const link = detail.createEl('a', { text: `${emptyFiles.length} files` });
            link.onclick = () => new EmptyTagsModal(this.app, emptyFiles).open();
        }
    }
}

class TagManagerModal extends Modal {
    plugin: TagLowercasePlugin;
    statsEl: HTMLElement;

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
        const mergeWarning = targetCol.createDiv({ cls: 'btm-conflict-warning' });
        mergeWarning.hide();

        new InlineTagSuggest(this.app, this.mergeTargetInput.inputEl, targetCol, (t) => {
            this.mergeTargetInput.setValue(t);
            this.mergeTargetInput.inputEl.dispatchEvent(new Event('input'));
        });

        this.mergeTargetInput.inputEl.addEventListener('input', () => {
            const target = this.mergeTargetInput.getValue().trim();
            const cleanTarget = target.replace(/^#/, '');
            const globalTags = this.plugin.app.metadataCache.getTags() ?? {};
            if (globalTags['#' + cleanTarget] !== undefined) {
                mergeWarning.textContent = `⚠️ #${cleanTarget} already exists. This will merge into the existing tag.`;
                mergeWarning.show();
            } else {
                mergeWarning.hide();
            }
        });

        const targetSuggestBtn = targetCol.createEl('button', { cls: 'btm-suggest-btn btm-icon-btn btm-small-center-btn' });
        setIcon(targetSuggestBtn, 'search');
        targetSuggestBtn.createSpan({ text: ' Search' });
        targetSuggestBtn.onclick = () => new TagSuggest(this.app, this.plugin, (t) => {
            this.mergeTargetInput.setValue(t);
            this.mergeTargetInput.inputEl.dispatchEvent(new Event('input'));
        }).open();

        // Col 3: Action
        const mergeActionCol = mergeContainer.createDiv({ cls: 'btm-field-column' });
        const btnMerge = mergeActionCol.createEl('button', { text: 'Merge', cls: 'mod-cta btm-action-btn' });
        btnMerge.onclick = () => {
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

        // --- Nest Tags Section ---
        const nestBox = contentEl.createDiv({ cls: 'btm-section-box' });
        nestBox.createDiv({ cls: 'btm-collapsible-header' }).createSpan({ text: 'Nest Tags' });

        const nestContainer = nestBox.createDiv({ cls: 'btm-aligned-row' });

        // Col 1: Parent tag
        const nestParentCol = nestContainer.createDiv({ cls: 'btm-field-column' });
        nestParentCol.createEl('label', { text: 'Parent tag' });
        const nestParentInput = new TextComponent(nestParentCol).setPlaceholder('#parent (e.g. enfermedades)');

        new InlineTagSuggest(this.app, nestParentInput.inputEl, nestParentCol, (t) => {
            nestParentInput.setValue(t);
        });

        const nestParentSuggestBtn = nestParentCol.createEl('button', { cls: 'btm-suggest-btn btm-icon-btn btm-small-center-btn' });
        setIcon(nestParentSuggestBtn, 'search');
        nestParentSuggestBtn.createSpan({ text: ' Search' });
        nestParentSuggestBtn.onclick = () => new TagSuggest(this.app, this.plugin, (t) => {
            nestParentInput.setValue(t);
        }).open();

        // Col 2: Child tags
        const nestChildCol = nestContainer.createDiv({ cls: 'btm-field-column' });
        nestChildCol.createEl('label', { text: 'Tags to nest' });
        const nestChildInput = new TextComponent(nestChildCol).setPlaceholder('#tag1, #tag2, #tag3');

        const nestSelectBtn = nestChildCol.createEl('button', { cls: 'btm-suggest-btn btm-icon-btn btm-small-center-btn' });
        setIcon(nestSelectBtn, 'list-filter');
        nestSelectBtn.createSpan({ text: ' Select' });
        nestSelectBtn.onclick = () => new MultiTagSelectModal(this.app, this.plugin, (tags) => {
            nestChildInput.setValue(tags.map(t => '#' + t).join(', '));
        }).open();

        // Col 3: Action
        const nestActionCol = nestContainer.createDiv({ cls: 'btm-field-column' });
        const btnNest = nestActionCol.createEl('button', { text: 'Nest', cls: 'mod-cta btm-action-btn' });
        btnNest.onclick = () => {
            const parent = nestParentInput.getValue().trim();
            const children = nestChildInput.getValue().split(',').map(s => s.trim()).filter(s => s);
            if (parent && children.length > 0) {
                const parentClean = parent.replace(/^#/, '');
                new BtmConfirmationModal(
                    this.app,
                    'Nest Tags',
                    `Nest ${children.length} tag(s) under "#${parentClean}"? Each tag will be renamed to #${parentClean}/tagname.`,
                    async () => {
                        this.close();
                        await this.plugin.nestTags(parent, children);
                    }
                ).open();
            } else {
                new Notice('Please provide a parent tag and at least one child tag.');
            }
        };

        // --- Batch Rename (table) ---
        const batchBox = contentEl.createDiv({ cls: 'btm-section-box' });
        batchBox.createDiv({ cls: 'btm-collapsible-header' }).createSpan({ text: 'Rename Tags' });
        batchBox.createEl('p', {
            text: 'Rename multiple tags at once. Each row is an independent old → new pair.',
            cls: 'btm-section-desc'
        });

        const batchPairs: { from: TextComponent; to: TextComponent; row: HTMLElement }[] = [];

        const batchTable = batchBox.createDiv({ cls: 'btm-batch-table' });

        const addBatchRow = () => {
            const row = batchTable.createDiv({ cls: 'btm-batch-row' });

            const fromInput = new TextComponent(row).setPlaceholder('#old-tag');
            fromInput.inputEl.addClass('btm-flex-1');
            new InlineTagSuggest(this.app, fromInput.inputEl, row, (tag) => {
                fromInput.setValue(tag);
            });

            row.createSpan({ text: '→', cls: 'btm-batch-arrow' });

            const toInput = new TextComponent(row).setPlaceholder('#new-tag');
            toInput.inputEl.addClass('btm-flex-1');
            new InlineTagSuggest(this.app, toInput.inputEl, row, (tag) => {
                toInput.setValue(tag);
            });

            const removeBtn = row.createEl('button', { cls: 'btm-icon-btn btm-shrink-0' });
            setIcon(removeBtn, 'x');
            removeBtn.onclick = () => {
                const idx = batchPairs.findIndex(p => p.row === row);
                if (idx !== -1) batchPairs.splice(idx, 1);
                row.remove();
            };

            batchPairs.push({ from: fromInput, to: toInput, row });
        };

        // Start with two empty rows
        addBatchRow();
        addBatchRow();

        const batchControlRow = batchBox.createDiv({ attr: { style: 'display: flex; gap: 8px; align-items: center;' } });

        const addRowBtn = batchControlRow.createEl('button', { text: '+ Add row', cls: 'btm-suggest-btn btm-icon-btn btm-small-center-btn' });
        addRowBtn.onclick = () => addBatchRow();

        const btnBatchRename = batchControlRow.createEl('button', { text: 'Apply', cls: 'mod-cta btm-action-btn' });
        btnBatchRename.onclick = () => {
            const pairs = batchPairs
                .map(p => ({ from: p.from.getValue().trim(), to: p.to.getValue().trim() }))
                .filter(p => p.from && p.to);

            if (pairs.length === 0) {
                new Notice('Please fill at least one rename pair.');
                return;
            }

            new BtmConfirmationModal(
                this.app,
                'Rename Tags',
                `Apply ${pairs.length} rename pair(s) across the vault?`,
                async () => {
                    this.close();
                    await this.plugin.renameTagBatch(pairs);
                }
            ).open();
        };

        // --- Rename from CSV Section ---
        const csvBox = contentEl.createDiv({ cls: 'btm-section-box' });
        csvBox.createDiv({ cls: 'btm-collapsible-header' }).createSpan({ text: 'Batch Rename from CSV' });
        csvBox.createEl('p', {
            text: 'Upload a CSV with columns old_tag,new_tag to rename many tags at once.',
            cls: 'btm-section-desc'
        });

        const csvContainer = csvBox.createDiv({ cls: 'btm-aligned-row' });
        const csvCol = csvContainer.createDiv({ cls: 'btm-field-column' });
        csvCol.setAttr('style', 'grid-column: span 2;');

        const csvFileInput = csvCol.createEl('input', { type: 'file' });
        csvFileInput.accept = '.csv';
        csvFileInput.hide();

        const csvPreview = csvCol.createDiv({ cls: 'btm-csv-preview' });

        let parsedCsvPairs: { from: string; to: string }[] = [];

        csvFileInput.addEventListener('change', () => {
            const csvFile = csvFileInput.files?.[0];
            if (!csvFile) return;

            const reader = new FileReader();
            reader.onload = (e) => {
                const text = e.target?.result as string;
                parsedCsvPairs = parseCsvRenamePairs(text);
                csvPreview.empty();
                if (parsedCsvPairs.length === 0) {
                    csvPreview.createSpan({ text: 'No valid pairs found in CSV.' });
                    return;
                }
                csvPreview.createSpan({ text: `${parsedCsvPairs.length} pairs loaded:`, cls: 'btm-csv-count' });
                const previewList = csvPreview.createEl('ul', { attr: { style: 'margin: 4px 0; padding-left: 16px;' } });
                parsedCsvPairs.slice(0, 8).forEach(p => {
                    previewList.createEl('li', { text: `#${p.from} → #${p.to}` });
                });
                if (parsedCsvPairs.length > 8) {
                    previewList.createEl('li', { text: `... and ${parsedCsvPairs.length - 8} more`, cls: 'btm-more' });
                }
            };
            reader.readAsText(csvFile, 'UTF-8');
        });

        const csvBtnRow = csvCol.createDiv({ attr: { style: 'display: flex; gap: 8px; margin-top: 8px;' } });

        const uploadBtn = csvBtnRow.createEl('button', { text: 'Choose CSV', cls: 'btm-suggest-btn btm-icon-btn btm-small-center-btn' });
        const uploadIcon = uploadBtn.createSpan({ cls: 'btm-icon' });
        setIcon(uploadIcon, 'upload');
        uploadBtn.prepend(uploadIcon);
        uploadBtn.onclick = () => csvFileInput.click();

        const csvActionCol = csvContainer.createDiv({ cls: 'btm-field-column' });
        const btnCsvRename = csvActionCol.createEl('button', { text: 'Apply', cls: 'mod-cta btm-action-btn' });
        btnCsvRename.onclick = () => {
            if (parsedCsvPairs.length === 0) {
                new Notice('Please load a CSV file first.');
                return;
            }
            new BtmConfirmationModal(
                this.app,
                'Batch Rename from CSV',
                `Apply ${parsedCsvPairs.length} rename pairs across the vault?`,
                async () => {
                    this.close();
                    await this.plugin.renameTagBatch(parsedCsvPairs);
                }
            ).open();
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
        btnDelete.onclick = () => {
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

        // --- Delete from List Section ---
        const deleteListBox = contentEl.createDiv({ cls: 'btm-section-box' });
        deleteListBox.createDiv({ cls: 'btm-collapsible-header' }).createSpan({ text: 'Delete from List' });
        deleteListBox.createEl('p', {
            text: 'Upload a plain text file with one tag per line to delete many tags at once.',
            cls: 'btm-section-desc'
        });

        const deleteListFileInput2 = deleteListBox.createEl('input', { type: 'file' });
        deleteListFileInput2.accept = '.txt,.csv';
        deleteListFileInput2.hide();

        const deleteListPreview2 = deleteListBox.createDiv({ cls: 'btm-scroll-preview' });

        let parsedDeleteTags2: string[] = [];

        deleteListFileInput2.addEventListener('change', () => {
            const file = deleteListFileInput2.files?.[0];
            if (!file) return;
            const reader = new FileReader();
            reader.onload = (e) => {
                const text = e.target?.result as string;
                parsedDeleteTags2 = parseTagDeleteList(text);
                deleteListPreview2.empty();
                if (parsedDeleteTags2.length === 0) {
                    deleteListPreview2.createSpan({ text: 'No valid tags found in file.' });
                    return;
                }
                deleteListPreview2.createSpan({ text: `${parsedDeleteTags2.length} tags loaded:` });
                const previewList = deleteListPreview2.createEl('ul', { attr: { style: 'margin: 4px 0; padding-left: 16px;' } });
                parsedDeleteTags2.slice(0, 8).forEach(t => {
                    previewList.createEl('li', { text: `#${t}` });
                });
                if (parsedDeleteTags2.length > 8) {
                    previewList.createEl('li', { text: `... and ${parsedDeleteTags2.length - 8} more` });
                }
            };
            reader.readAsText(file, 'UTF-8');
        });

        const deleteListBtnRow2 = deleteListBox.createDiv({ attr: { style: 'display: flex; gap: 8px; align-items: center; justify-content: space-between; margin-top: 8px;' } });

        const chooseDeleteListBtn2 = deleteListBtnRow2.createEl('button', { text: 'Choose file', cls: 'btm-suggest-btn btm-icon-btn btm-small-center-btn' });
        setIcon(chooseDeleteListBtn2, 'upload');
        chooseDeleteListBtn2.onclick = () => deleteListFileInput2.click();

        const applyDeleteListBtn2 = deleteListBtnRow2.createEl('button', { text: 'Delete All', cls: 'mod-warning btm-action-btn' });
        applyDeleteListBtn2.onclick = () => {
            if (parsedDeleteTags2.length === 0) {
                new Notice('Please load a file first.');
                return;
            }
            new BtmConfirmationModal(
                this.app,
                'Delete from List',
                `Permanently delete ${parsedDeleteTags2.length} tag(s) from the vault? This cannot be undone without using the undo history.`,
                async () => {
                    this.close();
                    await this.plugin.deleteTags(parsedDeleteTags2);
                }
            ).open();
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
        btnPattern.onclick = () => {
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
                .onChange((value: TagLowercaseSettings['caseStrategy']) => {
                    runAsync(async () => {
                        this.plugin.settings.caseStrategy = value;
                        await this.plugin.saveSettings();
                        this.updateStats().catch(e => console.error("Failed to update stats", e));
                    });
                }));

        new Setting(settingsBox)
            .setName('Separator Style')
            .addDropdown(dropdown => dropdown
                .addOption('preserve', 'Preserve')
                .addOption('snake', 'Snake Case')
                .addOption('kebab', 'Kebab Case')
                .setValue(this.plugin.settings.separatorStrategy)
                .onChange((value: TagLowercaseSettings['separatorStrategy']) => {
                    runAsync(async () => {
                        this.plugin.settings.separatorStrategy = value;
                        await this.plugin.saveSettings();
                        this.updateStats().catch(e => console.error("Failed to update stats", e));
                    });
                }));

        new Setting(settingsBox)
            .setName('Remove Special Characters')
            .setDesc('Removes everything except letters, numbers, hyphens (-), and underscores (_).')
            .addToggle(toggle => toggle
                .setValue(this.plugin.settings.removeSpecialChars)
                .onChange((value) => {
                    runAsync(async () => {
                        this.plugin.settings.removeSpecialChars = value;
                        await this.plugin.saveSettings();
                        this.updateStats().catch(e => console.error("Failed to update stats", e));
                    });
                }));

        new Setting(settingsBox)
            .setName('Flatten Diacritics')
            .setDesc('Converts accented characters to their plain equivalents (e.g., á → a, å → a).')
            .addToggle(toggle => toggle
                .setValue(this.plugin.settings.flattenDiacritics)
                .onChange((value) => {
                    runAsync(async () => {
                        this.plugin.settings.flattenDiacritics = value;
                        await this.plugin.saveSettings();
                        this.updateStats().catch(e => console.error("Failed to update stats", e));
                    });
                }));

        new Setting(settingsBox)
            .setName('Apply to Nested Tags')
            .addToggle(toggle => toggle
                .setValue(this.plugin.settings.applyToNestedTags)
                .onChange((value) => {
                    runAsync(async () => {
                        this.plugin.settings.applyToNestedTags = value;
                        await this.plugin.saveSettings();
                        this.updateStats().catch(e => console.error("Failed to update stats", e));
                    });
                }));

        // --- Scope Filter (Moved inside Bulk Settings) ---
        new Setting(settingsBox).setName('Scope Filter').setHeading();
        new Setting(settingsBox)
            .setName('Enable Scope Filter')
            .setDesc('Limit operations to specific folders')
            .addToggle(toggle => toggle
                .setValue(this.plugin.settings.scopeFilter.enabled)
                .onChange((value) => {
                    runAsync(async () => {
                        this.plugin.settings.scopeFilter.enabled = value;
                        await this.plugin.saveSettings();
                        this.updateStats().catch(e => console.error("Failed to update stats", e));
                    });
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
        btnConvertBulk.onclick = () => {
            runAsync(async () => {
                this.close();
                await this.plugin.runConversionWithPreview();
            });
        };

        // Removed Fix Invalid from here (it belongs in the Invalid Tags block below Overview)



        // --- Metadata Utilities ---
        const utilBox = contentEl.createDiv({ cls: 'btm-section-box' });
        utilBox.createDiv({ cls: 'btm-collapsible-header' }).createSpan({ text: 'Metadata Utilities' });
        const utilRow = utilBox.createDiv({ cls: 'btm-util-column' });
        
        const btnClean = this.createIconButton(utilRow, 'file-check', 'Clean front matter formatting');
        setTooltip(btnClean, 'Remove unnecessary quotes and trim whitespace from all frontmatter fields');
        btnClean.onclick = () => void this.plugin.standardiseProperties();

        const btnAllInline = this.createIconButton(utilRow, 'list-plus', 'Standardise to Inline Array');
        setTooltip(btnAllInline, 'Convert all tags AND wiki link properties to Inline Array format [ ]');
        btnAllInline.onclick = () => {
            const files = this.plugin.getFilteredFiles();
            new BtmConfirmationModal(
                this.app,
                'Standardise All to Inline Array',
                `Are you sure you want to convert all tags and wiki links to Inline Array across ${files.length} files?`,
                async () => {
                    const progressModal = new ProgressModal(this.app, files.length * 2);
                    progressModal.open();
                    
                    await this.plugin.convertTagFormat(files, 'inline', true);
                    progressModal.update(files.length);
                    
                    await this.plugin.convertWikiLinkFormat(files, 'inline', true);
                    
                    progressModal.close();
                    this.updateStats().catch(e => console.error("Failed to update stats", e));
                    new Notice('Finished standardising all properties to Inline Array.');
                }
            ).open();
        };

        const btnAllList = this.createIconButton(utilRow, 'list-minus', 'Standardise to YAML List');
        setTooltip(btnAllList, 'Convert all tags AND wiki link properties to multiline YAML List format -');
        btnAllList.onclick = () => {
            const files = this.plugin.getFilteredFiles();
            new BtmConfirmationModal(
                this.app,
                'Standardise All to YAML List',
                `Are you sure you want to convert all tags and wiki links to YAML List across ${files.length} files?`,
                async () => {
                    const progressModal = new ProgressModal(this.app, files.length * 2);
                    progressModal.open();
                    
                    await this.plugin.convertTagFormat(files, 'list', true);
                    progressModal.update(files.length);
                    
                    await this.plugin.convertWikiLinkFormat(files, 'list', true);
                    
                    progressModal.close();
                    this.updateStats().catch(e => console.error("Failed to update stats", e));
                    new Notice('Finished standardising all properties to YAML List.');
                }
            ).open();
        };

        // --- Action Row (Bottom) ---
        const actionBox = contentEl.createDiv({ cls: 'btm-section-box' });
        actionBox.createDiv({ cls: 'btm-collapsible-header' }).createSpan({ text: 'Other actions' });
        const actionRow = actionBox.createDiv({ cls: 'btm-action-row' });

        // Convert All moved to Bulk Settings

        const btnList = this.createIconButton(actionRow, 'list', 'Tag List');
        setTooltip(btnList, 'View all tags in a list');
        btnList.onclick = () => {
            runAsync(async () => {
                this.close();
                await this.plugin.generateTagList();
            });
        };

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
        fill.setCssProps({ width: `${value}%` });
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
        btnUpper.onclick = () => { 
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
        btnLower.onclick = () => { 
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
        btnToInline.onclick = () => {
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
        btnToList.onclick = () => {
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

        // Wiki Link Format Style
        const wikiBox = this.metricsGrid.createDiv({ cls: 'btm-metric-box' });
        wikiBox.createDiv({ text: 'Wiki Link Format Style', cls: 'btm-metric-label' });

        const wikiContent = wikiBox.createDiv({ cls: 'btm-metric-details', attr: { style: 'display:block; margin-bottom: 5px;' } });

        const createWikiLinkStats = (label: string, files: TFile[]) => {
            if (files.length > 0) {
                const link = wikiContent.createEl('a', { text: `${label}: ${files.length} files`, cls: 'btm-stat-link', attr: { style: 'display:block;' } });
                link.onclick = () => {
                    this.close();
                    new SimpleFileListModal(this.app, label, files).open();
                };
            } else {
                wikiContent.createDiv({ text: `${label}: 0 files`, attr: { style: 'color: var(--text-muted); font-size: var(--font-ui-smaller);' } });
            }
        };

        createWikiLinkStats('YAML List', stats.wikiLinkStats.yamlList);
        createWikiLinkStats('Inline Array', stats.wikiLinkStats.inlineArray);

        const wikiActions = wikiBox.createDiv({ cls: 'btm-format-actions', attr: { style: 'margin-top: auto; display: flex; flex-direction: column; gap: 4px;' } });

        const btnWikiToInline = wikiActions.createEl('button', { text: 'Convert All to Inline', cls: 'btm-small-btn' });
        btnWikiToInline.onclick = () => {
            new BtmConfirmationModal(
                this.app,
                'Convert Wiki Links to Inline Array',
                'Are you sure you want to convert ALL wiki link properties to the ["[[Link]]"] inline format?',
                async () => {
                    await this.plugin.convertWikiLinkFormat(files, 'inline');
                    this.updateStats().catch(e => console.error("Failed to update stats", e));
                }
            ).open();
        };

        const btnWikiToList = wikiActions.createEl('button', { text: 'Convert All to List', cls: 'btm-small-btn' });
        btnWikiToList.onclick = () => {
            new BtmConfirmationModal(
                this.app,
                'Convert Wiki Links to YAML List',
                'Are you sure you want to convert ALL wiki link properties to the YAML list format?',
                async () => {
                    await this.plugin.convertWikiLinkFormat(files, 'list');
                    this.updateStats().catch(e => console.error("Failed to update stats", e));
                }
            ).open();
        };

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
        createStatLink(lengthDetails, stats.lengthStats.long.length, 'long (>25)', stats.lengthStats.long);

        // Case Duplicates
        if (stats.caseDuplicates.length > 0) {
            const dupBox = this.metricsGrid.createDiv({ cls: 'btm-metric-box' });
            dupBox.createDiv({ text: 'Potential Case Duplicates', cls: 'btm-metric-label' });
            const dupDetails = dupBox.createDiv({ cls: 'btm-metric-details' });
            
            const dupLink = dupDetails.createEl('a', { 
                text: `${stats.caseDuplicates.length} pairs of duplicate tags`, 
                cls: 'btm-stat-link btm-warning-link' 
            });
            dupLink.onclick = () => {
                this.close();
                const listEl = new TagListModal(this.app, 'Case Duplicates', stats.caseDuplicates.flatMap(d => d.variants));
                listEl.open();
            };

            const mergeAllBtn = dupBox.createEl('button', { text: 'Merge all to canonical', cls: 'btm-small-btn btm-warning-btn', attr: { style: 'margin-top: auto;' } });
            setTooltip(mergeAllBtn, 'Merge all case variants into their most-used versions');
            mergeAllBtn.onclick = () => {
                new BtmConfirmationModal(
                    this.app,
                    'Merge Case Duplicates',
                    `Are you sure you want to merge ${stats.caseDuplicates.length} sets of case-variant tags? This will unify them using their most-used versions.`,
                    async () => {
                        this.close();
                        const progressModal = new ProgressModal(this.app, stats.caseDuplicates.length);
                        progressModal.open();
                        
                        let i = 0;
                        for (const { canonical, variants } of stats.caseDuplicates) {
                            const sources = variants.filter(v => v !== canonical);
                            await this.plugin.mergeTags(sources, canonical);
                            i++;
                            progressModal.update(i);
                        }
                        
                        progressModal.close();
                        new Notice('Finished merging case duplicates.');
                    }
                ).open();
            };
        }

        // Async check for invalid tags
        this.checkInvalidTags().catch(e => console.error("Failed to check invalid tags", e));
        this.checkEmptyTags().catch(e => console.error("Failed to check empty tags", e));
    }

    async checkInvalidTags() {
        if (!this.invalidContentEl) return;
        this.invalidContentEl.empty();
        
        const invalidFiles = await this.plugin.findInvalidTagFormats();

        if (invalidFiles.length > 0) {
            this.invalidBlock.show();
            
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
            this.invalidBlock.hide();
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
        containerEl.addClass('btm-settings-page');

        const dashboardSection = containerEl.createDiv({ cls: 'btm-settings-section' });
        new Setting(dashboardSection).setName('Dashboard').setHeading();
        new BulkManagerSettingsDashboard(this.app, this.plugin, dashboardSection.createDiv({ cls: 'btm-dashboard' })).render();

        const aliasesSection = containerEl.createDiv({ cls: 'btm-section-box' });
        new Setting(aliasesSection).setName('Aliases').setHeading();
        aliasesSection.createEl('p', { text: 'Define tag aliases that automatically correct to canonical tags.' });

        const aliasesContainer = aliasesSection.createDiv({ cls: 'btm-aliases' });
        this.renderAliases(aliasesContainer);

        const protectedSection = containerEl.createDiv({ cls: 'btm-section-box' });
        new Setting(protectedSection).setName('Protected Tags').setHeading();
        protectedSection.createEl('p', { text: 'Tags listed here will be ignored by all rename, merge, and delete operations. You can use an asterisk (*) at the end for wildcards (e.g. #status/*).' });

        const protectedContainer = protectedSection.createDiv({ cls: 'btm-aliases' });
        this.renderProtectedTags(protectedContainer);

        const historySection = containerEl.createDiv({ cls: 'btm-section-box' });
        new Setting(historySection).setName('History').setHeading();

        new Setting(historySection)
            .setName('Max History Size')
            .setDesc('Number of operations to keep in history')
            .addSlider(slider => slider
                .setLimits(10, 100, 10)
                .setValue(this.plugin.settings.maxHistorySize)
                .setDynamicTooltip()
                .onChange((value) => {
                    runAsync(async () => {
                        this.plugin.settings.maxHistorySize = value;
                        await this.plugin.saveSettings();
                    });
                }));

        new Setting(historySection)
            .setName('History Expiration (Days)')
            .setDesc('Automatically delete history older than this many days (0 to disable).')
            .addSlider(slider => slider
                .setLimits(0, 30, 1)
                .setValue(this.plugin.settings.historyExpirationDays)
                .setDynamicTooltip()
                .onChange((value) => {
                    runAsync(async () => {
                        this.plugin.settings.historyExpirationDays = value;
                        await this.plugin.saveSettings();
                    });
                }));

        new Setting(historySection)
            .setName('Orphan Threshold')
            .setDesc('Tags used fewer times than this are considered orphaned')
            .addSlider(slider => slider
                .setLimits(1, 10, 1)
                .setValue(this.plugin.settings.orphanThreshold)
                .setDynamicTooltip()
                .onChange((value) => {
                    runAsync(async () => {
                        this.plugin.settings.orphanThreshold = value;
                        await this.plugin.saveSettings();
                    });
                }));

        new Setting(historySection)
            .setName('Clear History')
            .setDesc('Remove all operation history')
            .addButton(btn => btn
                .setButtonText('Clear')
                .setWarning()
                .onClick(() => {
                    runAsync(async () => {
                        for (const op of this.plugin.settings.operationHistory) {
                            await this.plugin.deleteExternalHistory(op.id);
                        }
                        this.plugin.settings.operationHistory = [];
                        await this.plugin.saveSettings();
                        new Notice('History cleared.');
                    });
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
                    .onClick(() => {
                        runAsync(async () => {
                            delete this.plugin.settings.aliases[alias];
                            await this.plugin.saveSettings();
                            this.renderAliases(container);
                        });
                    }));
        }

        const addRow = container.createDiv({ cls: 'btm-add-alias' });
        const aliasInput = new TextComponent(addRow).setPlaceholder('alias');
        const canonicalInput = new TextComponent(addRow).setPlaceholder('canonical');
        const addBtn = addRow.createEl('button', { text: 'Add' });
        addBtn.onclick = () => {
            runAsync(async () => {
                const a = aliasInput.getValue().replace(/^#/, '');
                const c = canonicalInput.getValue().replace(/^#/, '');
                if (a && c) {
                    this.plugin.settings.aliases[a] = c;
                    await this.plugin.saveSettings();
                    this.renderAliases(container);
                }
            });
        };
    }

    renderProtectedTags(container: HTMLElement) {
        container.empty();
        // Ensure array exists to prevent mapping errors on fresh installs
        const protectedTags = this.plugin.settings.protectedTags || [];

        protectedTags.forEach((tag, index) => {
            new Setting(container)
                .setName(tag)
                .addButton(btn => btn
                    .setIcon('trash')
                    .setWarning()
                    .onClick(() => {
                        runAsync(async () => {
                            this.plugin.settings.protectedTags.splice(index, 1);
                            await this.plugin.saveSettings();
                            this.renderProtectedTags(container);
                        });
                    }));
        });

        const addRow = container.createDiv({ cls: 'btm-add-alias' });
        const tagInput = new TextComponent(addRow).setPlaceholder('#tag/to/protect');
        tagInput.inputEl.addClass('btm-flex-1');
        
        const addBtn = addRow.createEl('button', { text: 'Protect' });
        addBtn.onclick = () => {
            runAsync(async () => {
                let t = tagInput.getValue().trim();
                if (t) {
                    if (!t.startsWith('#')) t = '#' + t;
                    
                    // Safety initialization just in case
                    if (!this.plugin.settings.protectedTags) {
                        this.plugin.settings.protectedTags = [];
                    }
                    
                    if (!this.plugin.settings.protectedTags.includes(t)) {
                        this.plugin.settings.protectedTags.push(t);
                        await this.plugin.saveSettings();
                        this.renderProtectedTags(container);
                    }
                }
            });
        };
    }
}

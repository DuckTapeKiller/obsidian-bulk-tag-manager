
// In InvalidTagsModal
// ... inside loop over invalidFiles
const fixBtn = headerEl.createEl('button', { text: 'Fix', cls: 'btm-view-invalid-btn' });
fixBtn.onclick = async () => {
    this.close();
    await this.plugin.fixInvalidTags(item);
};
    // ...

    // In TagLowercasePlugin class
    async fixInvalidTags(fileInfo: InvalidTagFile) {
    const file = fileInfo.file;
    try {
        const before = await this.app.vault.read(file);
        let modified = false;

        const INVALID_CHARS_REGEX = /[!'@#$%^&*()={}\[\]:;"<>,.?~`]/g;
        const PURE_NUMERIC = /^\d+$/;

        const fixTag = (t: string): string | null => {
            const trimmed = t.trim();
            // If purely numeric, return null to signal DELETION
            if (PURE_NUMERIC.test(trimmed)) return null;

            // Otherwise replace invalid chars with empty string or sensible replacement?
            // User asked to REMOVE apostrophe: spider's -> spiders
            // User asked to REMOVE conflictive chars: david_walker_(abolicionista) -> david_walker_abolicionista
            // So we remove them.
            let fixed = trimmed.replace(INVALID_CHARS_REGEX, '');

            // Also handle spaces -> underscores or hyphens? 
            // User gave example: "david_walker_" implies underscores are fine.
            // Obsidian tags usually use hyphens or underscores.
            // If tag had spaces "my tag", standard behavior is usually replace with hyphen or underscore.
            // But the user didn't explicitly ask for space fixing here, just special chars.
            // Existing logic flags spaces. Let's replace spaces with hyphens as a safe default for invalid tags.
            fixed = fixed.replace(/\s+/g, '-');

            return fixed;
        };

        await this.app.fileManager.processFrontMatter(file, (fm) => {
            const process = (val: any): any => {
                if (typeof val === 'string') {
                    // Check array-in-string "tag1, tag2"
                    if (val.includes(',')) {
                        modified = true;
                        // Convert to list and fix each
                        return val.split(',').map(s => fixTag(s)).filter(s => s !== null);
                    }
                    const fixed = fixTag(val);
                    if (fixed !== val) modified = true;
                    // If null, it means delete. But processFrontMatter expects a value.
                    // If top level is null, we can delete key? 
                    // Simplification: if numeric, we return null? 
                    return fixed;
                }
                if (Array.isArray(val)) {
                    const originalLen = val.length;
                    const fixedArray = val.map(t => fixTag(t)).filter(t => t !== null && t.length > 0);
                    if (JSON.stringify(fixedArray) !== JSON.stringify(val)) {
                        modified = true;
                        return fixedArray;
                    }
                    return val;
                }
                return val;
            };

            if (fm.tags) {
                const res = process(fm.tags);
                // If result is null (numeric single tag), delete key
                if (res === null) delete fm.tags;
                else fm.tags = res;
            }
            if (fm.tag) {
                const res = process(fm.tag);
                if (res === null) delete fm.tag;
                else fm.tag = res;
            }
        });

        // Handle Inline Tags? 
        // Invalid tags in body: #57357357 or #the_spider's
        // Regex match specific invalid ones?
        // "the_spider's" is technically recognized as valid #the_spider and text 's by Obsidian if distinct?
        // No, user says they are INVALID tags. 
        // If Obsidian sees #the_spider's, it treats it as tag #the_spider followed by 's. 
        // BUT if the user wants to fix it to #the_spiders, we need to find that pattern.
        // This is tricky for inline because we need to know what the user *intended* as the tag.
        // However, the `findInvalidTagFormats` likely only found frontmatter issues because finding inline invalid tags is hard 
        // (Obsidian parser defines what IS a tag).
        // Wait, looking at `findInvalidTagFormats`, it iterates `files.filter` but mostly checks `cache.frontmatter`. 
        // It DOES NOT check inline tags for invalidity in the current loop.
        // So `fileInfo` comes from Frontmatter check.
        // So we only need to fix Frontmatter for now.

        if (modified) {
            const after = await this.app.vault.read(file);
            // No history for simple fix? Or should we? 
            // It's a single file fix. Maybe simple notification is enough.
            new Notice(`Fixed tags in ${file.basename}`);
        } else {
            new Notice('No fixable tags found (or tags were already valid).');
        }

    } catch (e) {
        console.error('Failed to fix invalid tags', e);
        new Notice('Failed to fix tags.');
    }
}


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

            // Process Body
            await this.app.vault.process(file, (data) => {
                const newData = data.replace(tagRegex, (match, prefix) => {
                    modified = true;
                    return prefix; // Keep the prefix (space/start), remove the tag
                });
                return newData;
            });

            if (modified) {
                const after = await this.app.vault.read(file);
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

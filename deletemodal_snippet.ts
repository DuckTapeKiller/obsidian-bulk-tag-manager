
// --- Delete Tags Section ---
const deleteBox = contentEl.createDiv({ cls: 'btm-section-box' });
deleteBox.createDiv({ cls: 'btm-collapsible-header' }).createSpan({ text: 'Delete Tags' });

const deleteContainer = deleteBox.createDiv({ cls: 'btm-aligned-row' });

// Col 1: Tags
const deleteCol = deleteContainer.createDiv({ cls: 'btm-field-column' });
// Make it span 2 columns in the grid if possible, or just normal width
// The grid is 1fr 1fr auto.
// We can make Col 1 take up space. 
// Or just follow pattern: 
// Col 1: Input
// Col 2: Empty or Instructions?
// Let's modify btm-aligned-row for this one or just accept the grid.
// Actually, if I just put content in Col 1, Col 2 will be empty space. That's fine.

// Wait, I want the input to be wide.
// Grid: 1fr 1fr auto.
// If I only use Col 1, it's 1/2 width approx.
// I can set grid-column: span 2 for the first child if I wanted.
// Let's create a custom style inline or just live with it.
// Let's use the standard layout for consistency:
// Col 1: Tags Input
// Col 2: (Empty/Spacer)
// Col 3: Delete Button

deleteCol.createEl('label', { text: 'Tags to Delete' });
this.deleteInput = new TextComponent(deleteCol).setPlaceholder('#bad-tag, #unused');
this.deleteInput.inputEl.style.width = '100%';

// Helper buttons under input
const delBtnRow = deleteCol.createDiv({ cls: 'btm-helper-row' });
// Actually, previous inputs had buttons in the column.
const delSelectBtn = deleteCol.createEl('button', { cls: 'btm-suggest-btn btm-icon-btn btm-small-center-btn' });
setIcon(delSelectBtn, 'list-filter');
delSelectBtn.createSpan({ text: ' Select' });
delSelectBtn.onclick = () => new MultiTagSelectModal(this.app, this.plugin, (tags) => {
    this.deleteInput.setValue(tags.map(t => '#' + t).join(', '));
}).open();

// Col 2: Spacer / Search helper
const deleteSpacerCol = deleteContainer.createDiv({ cls: 'btm-field-column' });
// Maybe put "Search" button here just to fill space or leave empty
// Let's leave empty or put user tip? "Careful!"
deleteSpacerCol.createEl('label', { text: ' ' }); // Spacer label
const delSearchBtn = deleteSpacerCol.createEl('button', { cls: 'btm-suggest-btn btm-icon-btn btm-small-center-btn' });
// Actually better to have Search next to Select in Col 1? 
// Most sections have Col 1 (Find) and Col 2 (Replace).
// Here we only have 1 input.
// Let's make Col 1 span 2 columns via style.
deleteCol.setAttr('style', 'grid-column: span 2;');

// Add Search button next to Select button in Col 1
const delSearchSpan = delSelectBtn.createSpan({ text: '' }); // Just separation?
// No, append to deleteCol.
const delSearchBtnReal = deleteCol.createEl('button', { cls: 'btm-suggest-btn btm-icon-btn btm-small-center-btn', attr: { style: 'margin-left: 8px;' } });
setIcon(delSearchBtnReal, 'search');
delSearchBtnReal.createSpan({ text: ' Search' });
delSearchBtnReal.onclick = () => new TagSuggest(this.app, this.plugin, (t) => {
    const current = this.deleteInput.getValue();
    this.deleteInput.setValue(current ? current + ', #' + t : '#' + t);
}).open();

// Need a dummy Col 2 if I don't use span, but I used span.
// The grid expects 3 items usually? 
// If deleteCol spans 2, then we just need the 3rd item (Action).

// Col 3: Action
const btnDelete = deleteContainer.createEl('button', { text: 'Delete', cls: 'mod-warning btm-action-btn' });
btnDelete.onclick = async () => {
    const tags = this.deleteInput.getValue().split(',').map(s => s.trim()).filter(s => s);
    if (tags.length > 0) {
        // Confirmation?
        // Simple Notice for now or assume Undo is enough.
        // "mod-warning" implies danger.
        this.close();
        await this.plugin.deleteTags(tags);
    } else {
        new Notice('Please provide tags to delete.');
    }
};

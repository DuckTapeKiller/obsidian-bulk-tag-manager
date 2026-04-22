
class TagNode {
    constructor(name, fullPath) {
        this.name = name;
        this.fullPath = fullPath;
        this.count = 0;
        this.children = [];
    }
}

function getTagHierarchy(tags) {
    const root = [];
    for (const [tag, count] of Object.entries(tags)) {
        const parts = tag.substring(1).split('/');
        let currentLevel = root;
        let currentPath = '';

        for (let i = 0; i < parts.length; i++) {
            const part = parts[i];
            currentPath = currentPath ? `${currentPath}/${part}` : part;

            let existingNode = currentLevel.find(n => n.name === part);

            if (!existingNode) {
                existingNode = new TagNode(part, currentPath);
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

const mockTags = {
    "#mitología_griega": 5,
    "#mitología_griega/personaje": 3,
    "#mitología_griega/personaje/dios": 1,
    "#física": 10
};

const hierarchy = getTagHierarchy(mockTags);
console.log(JSON.stringify(hierarchy, null, 2));

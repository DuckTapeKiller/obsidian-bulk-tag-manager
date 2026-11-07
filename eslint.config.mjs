import tseslint from 'typescript-eslint';
import obsidianmd from 'eslint-plugin-obsidianmd';
import globals from 'globals';
import { defineConfig } from 'eslint/config';

// Obsidian's official plugin lint, as the community-plugin review bot runs it:
// `obsidianmd.configs.recommended` with its own file globs (every TS and JS file,
// package.json, manifest.json and the licence). Only the build output and the
// dependencies are left out, and no rule is switched off.
export default defineConfig([
    {
        ignores: ['node_modules/', 'main.js']
    },
    ...obsidianmd.configs.recommended,
    {
        // The type-aware rules need the TypeScript program.
        files: ['**/*.ts'],
        languageOptions: {
            parserOptions: {
                projectService: true,
                tsconfigRootDir: import.meta.dirname
            }
        }
    },
    {
        // The build, lint and test scripts are plain Node modules outside the
        // TypeScript program.
        files: ['**/*.mjs'],
        ...tseslint.configs.disableTypeChecked
    },
    {
        files: ['**/*.mjs'],
        languageOptions: {
            globals: globals.node
        }
    }
]);

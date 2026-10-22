import {Platform} from 'obsidian';
// Obsidian evaluates one bundle with a custom require (relative modules are unsupported).
// esbuild wraps these branches in lazy initializers: mobile never evaluates desktop imports.
const implementation=Platform.isMobile?require('./mobile/main.ts'):require('./main.ts');
export default implementation.default;

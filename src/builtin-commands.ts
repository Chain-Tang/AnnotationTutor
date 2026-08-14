// Bundled OpenCode commands the plugin can install into the Vault's
// `.opencode/command/` folder. Currently two: the Excalidraw diagram
// generator — content adapted from the community `excalidraw-diagram` skill
// (axtonliu/axton-obsidian-visual-skills, MIT; see CREDITS.md) — and the
// read-only paper/PDF finder that routes the agent through the Vault without
// a local shell. Once installed they show up in the chat's `/` command list
// via ACP's `available_commands_update`.
// Kept as TS constants (not loose asset files) so the single-file esbuild
// bundle carries them without extra loader config.

export type BuiltinCommand = {
  /** File name under .opencode/command/ (also the /slash name). */
  name: string;
  /** Shown in the command dropdown and used for agent routing. */
  description: string;
  /** The prompt body the command injects. */
  body: string;
};

const EXCALIDRAW_BODY = `Generate an Excalidraw diagram from the learner's request and save it as an
Obsidian-format Excalidraw note in the current Vault folder.

## Output file format (strict, no deviations)

Create a \`.md\` file with exactly this structure:

---
excalidraw-plugin: parsed
tags: [excalidraw]
---
==⚠  Switch to EXCALIDRAW VIEW in the MORE OPTIONS menu of this document. ⚠== You can decompress Drawing data with the command palette: 'Decompress current Excalidraw file'. For more info check in plugin settings under 'Saving'

# Excalidraw Data

## Text Elements
%%
## Drawing
\`\`\`json
{"type":"excalidraw","version":2,"source":"https://github.com/zsviczian/obsidian-excalidraw-plugin","elements":[ ... ],"appState":{"gridSize":null,"viewBackgroundColor":"#ffffff"},"files":{}}
\`\`\`
%%

Rules:
- Leave the "## Text Elements" section empty; the plugin fills it.
- The JSON must sit inside the %% markers as shown.
- File name: [topic].[diagram-type].md (Chinese topic names are fine).

## Element constraints (violations break the renderer)

Every element needs: id (unique string), type (rectangle|ellipse|diamond|text|arrow|line),
x, y, width, height, angle: 0, strokeColor, backgroundColor ("transparent" or a fill),
fillStyle: "solid", strokeWidth: 2, strokeStyle ("solid"|"dashed"|"dotted"), roughness: 1,
opacity: 100, groupIds: [], roundness: {"type": 3}, seed (any integer), version: 1,
isDeleted: false, boundElements: null, updated: 1, link: null, locked: false.

Do NOT add frameId, index, versionNonce, or rawText fields. boundElements MUST be null,
never []. updated MUST be 1, never a timestamp.

Text elements additionally need: text, fontSize, fontFamily: 5, textAlign: "center",
verticalAlign: "middle", containerId: null, originalText (same as text), autoResize: true,
lineHeight: 1.25. Standalone text is left-aligned: estimate width as
text.length * fontSize * 0.5 (CJK characters * 1.0) and set x = centerX - width / 2.

## Design rules

- Diagram types: flowchart, mind map, hierarchy, relationship, comparison, timeline,
  matrix, freeform — pick the one matching the content's core need and say why.
- Canvas: keep elements within 0-1200 x 0-800, at least 20px apart, 50-80px edge padding.
- Shapes with text: minimum 120x60.
- Font sizes: titles 20-28, subtitles 18-20, body 16-18, never below 14.
- Replace " with 『』 and () with 「」 in text; no emoji.
- Text colors: titles #1e40af, subtitles/connectors #3b82f6, body #374151, emphasis #f59e0b.
  Never lighter than #757575 on white.
- Fills (fillStyle solid): #a5d8ff input/main, #b2f2bb success/output, #ffd8a8 warning/
  external, #d0bfff processing, #ffc9c9 error/critical, #fff3bf notes/decisions,
  #c3fae8 storage/data, #eebefa analysis/metrics. Region backgrounds: #dbe4ff, #e5dbff,
  #d3f9d8 at opacity 30.

After writing the file, tell the learner the path and remind them to switch the note to
Excalidraw view via the More Options menu.`;

const FIND_PAPER_BODY = `Search the learner's Vault for papers and notes matching the given keywords.
This is a read-only flow — never modify files or run shell commands.

## Steps

1. Use your read-only file tools (glob/grep/read) to scan the Vault for:
   - PDF files (*.pdf) whose file name matches any keyword;
   - Capture notes (frontmatter "type: web-capture") whose title, source-url,
     or quoted selection mentions the keywords.
2. Rank matches by keyword overlap and list at most 10 as a Markdown list:
   - PDFs: relative path, one line each — the learner opens them in Obsidian's
     built-in PDF view;
   - Notes: a [[wikilink]] with a one-line summary of the captured quote.
3. If the learner is looking for a specific paper, also check capture notes'
   "source-url" and "Reference" BibTeX blocks for DOIs/titles.
4. If nothing matches, say so plainly and suggest refining the keywords.

Never create or edit files during this flow.`;

export const BUILTIN_COMMANDS: BuiltinCommand[] = [
  {
    name: "excalidraw-diagram",
    description:
      "Generate an Excalidraw diagram (mind map, flowchart, relationship…) as an Obsidian drawing note.",
    body: EXCALIDRAW_BODY
  },
  {
    name: "find-paper",
    description:
      "Search the vault for PDFs and capture notes matching a topic; read-only, no file writes.",
    body: FIND_PAPER_BODY
  }
];

/** The .md file content for one bundled command (OpenCode command format). */
export function builtinCommandFile(command: BuiltinCommand): string {
  return `---\ndescription: ${command.description}\n---\n\n${command.body}\n`;
}

/** Where bundled commands are installed inside the Vault. */
export const BUILTIN_COMMAND_DIR = ".opencode/command";


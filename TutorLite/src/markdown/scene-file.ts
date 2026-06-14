import type { Scene } from "../model.js";
import { sceneSchema } from "../schemas.js";
import {
  parseFrontmatter,
  renderFrontmatter,
  section,
  stringArray,
  wikiLink,
  wikiLinkIds
} from "./frontmatter.js";

export function serializeScene(
  scene: Scene,
  memoryRoot = "Agent Memory"
): string {
  return renderFrontmatter(
    {
      schema: 2,
      kind: "scene",
      id: scene.id,
      type: scene.type,
      status: scene.status,
      title: scene.title,
      cells: scene.cells.map((id) =>
        wikiLink(`${memoryRoot}/memory-cells/${id}`, id)
      ),
      tags: scene.tags,
      created_at: scene.createdAt,
      updated_at: scene.updatedAt
    },
    `# ${scene.title}\n\n## Summary\n\n${scene.summary}\n`
  );
}

export function parseSceneFile(markdown: string): Scene | null {
  const document = parseFrontmatter(markdown);
  if (
    !document ||
    document.data.schema !== 2 ||
    document.data.kind !== "scene"
  ) {
    return null;
  }
  const parsed = sceneSchema.safeParse({
    id: document.data.id,
    type: document.data.type,
    title: document.data.title,
    status: document.data.status,
    summary: section(document.body, "Summary"),
    cells: wikiLinkIds(document.data.cells),
    tags: stringArray(document.data.tags),
    createdAt: document.data.created_at,
    updatedAt: document.data.updated_at
  });
  return parsed.success ? parsed.data : null;
}

import type {
  MemoryCellRecord,
  SceneRecord
} from "./library-index.js";
import type {
  MemoryCellStatus,
  MemoryCellType,
  SceneStatus,
  SceneType
} from "./model.js";

export type CellQuery = {
  text?: string;
  type?: MemoryCellType | "";
  status?: MemoryCellStatus | "";
  tag?: string;
};

export type SceneQuery = {
  text?: string;
  type?: SceneType | "";
  status?: SceneStatus | "";
  tag?: string;
};

export function queryCells(
  cells: MemoryCellRecord[],
  query: CellQuery = {}
): MemoryCellRecord[] {
  const text = query.text?.trim().toLowerCase();
  return cells
    .filter((cell) => {
      if (
        text &&
        ![
          cell.id,
          cell.concept,
          cell.summary,
          ...cell.tags,
          ...cell.sourceAnnotations,
          ...cell.sceneIds
        ]
          .join(" ")
          .toLowerCase()
          .includes(text)
      ) {
        return false;
      }
      if (query.type && cell.type !== query.type) return false;
      if (query.status && cell.status !== query.status) return false;
      if (query.tag && !cell.tags.includes(query.tag)) return false;
      return true;
    })
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
}

export function queryScenes(
  scenes: SceneRecord[],
  query: SceneQuery = {}
): SceneRecord[] {
  const text = query.text?.trim().toLowerCase();
  return scenes
    .filter((scene) => {
      if (
        text &&
        ![
          scene.id,
          scene.title,
          scene.summary,
          ...scene.tags,
          ...scene.cells,
          ...scene.sourceAnnotations
        ]
          .join(" ")
          .toLowerCase()
          .includes(text)
      ) {
        return false;
      }
      if (query.type && scene.type !== query.type) return false;
      if (query.status && scene.status !== query.status) return false;
      if (query.tag && !scene.tags.includes(query.tag)) return false;
      return true;
    })
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
}

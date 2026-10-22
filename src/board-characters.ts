import type { BoardExpression, TutorCharacterProfile } from "./board-types.js";

/** Simple vector primitives shared by the live canvas and portable SVG. */
export type CharacterPrimitive =
  | {
      kind: "ellipse";
      x: number;
      y: number;
      rx: number;
      ry: number;
      fill: string;
      stroke?: string;
      lineWidth?: number;
    }
  | {
      kind: "path";
      points: Array<[number, number]>;
      stroke: string;
      lineWidth: number;
      closed?: boolean;
      fill?: string;
    };

const EXPRESSIONS: readonly BoardExpression[] = [
  "thinking",
  "curious",
  "discovery",
  "encouraging",
  "celebrating",
  "quiet",
];
export const tutorCharacterExpressions = EXPRESSIONS;

export function boardStickerExpressions(profile: TutorCharacterProfile): readonly BoardExpression[] {
  return profile.style === "round" || profile.style === "book" ? EXPRESSIONS : ["quiet"];
}

export function boardStickerKey(profile: Pick<TutorCharacterProfile, "id" | "version">, expression: BoardExpression): string {
  return `${profile.id}:v${profile.version}:${expression}`;
}

export function builtInTutorCharacters(): TutorCharacterProfile[] {
  return [
    {
      id: "tutor-round",
      version: 1,
      name: "Round buddy",
      origin: "builtin",
      style: "round",
      width: 100,
      height: 100,
      createdAt: "2026-09-12T00:00:00.000Z",
    },
    {
      id: "tutor-book",
      version: 1,
      name: "Book sprite",
      origin: "builtin",
      style: "book",
      width: 100,
      height: 100,
      createdAt: "2026-09-12T00:00:00.000Z",
    },
  ];
}

/** Searchable, versioned board assets; stickers do not change the chosen Tutor. */
export function builtInBoardAssets(): TutorCharacterProfile[] {
  const faces: Array<{ expression: BoardExpression; name: string; text: string; tags: string[] }> = [
    { expression: "thinking", name: "Thinking", text: "(·_·?)", tags: ["thinking", "思考", "问题"] },
    { expression: "curious", name: "Curious", text: "(・o・)", tags: ["curious", "好奇", "疑惑"] },
    { expression: "discovery", name: "Discovery", text: "(☆▽☆)", tags: ["discovery", "发现", "懂了"] },
    { expression: "encouraging", name: "You can do it", text: "٩(•̀ᴗ•́)و", tags: ["encouraging", "加油", "鼓励"] },
    { expression: "celebrating", name: "Celebration", text: "(*^▽^*)", tags: ["celebrating", "庆祝", "开心"] },
    { expression: "quiet", name: "Quiet company", text: "(˘ᴗ˘)", tags: ["quiet", "安静", "陪读"] },
  ];
  return [
    ...builtInTutorCharacters().map(profile => ({ ...profile, usage: "character" as const, tags: ["character", "Tutor"] })),
    ...faces.map(({ expression, name, text, tags }): TutorCharacterProfile => {
      const id = `tutor-kaomoji-${expression}`;
      return {
        id, version: 1, name, origin: "builtin", style: "custom", usage: "sticker",
        width: 240, height: 64, tags: ["kaomoji", "颜文字", ...tags],
        createdAt: "2026-09-12T00:00:00.000Z",
        objects: [{
          id: `${id}-text`, kind: "text", anchor: { kind: "markdown", key: "asset", quote: "" },
          x: 0, y: 0, width: 240, height: 64, text, textStyle: { font: "sans", size: 34, align: "center" },
          color: "#45404b", strokeWidth: 2, createdBy: "tutor", editedBy: "tutor", revision: 1,
          groupId: `${id}-group`,
        }],
      };
    }),
  ];
}

/** Original 100×100 designs; no remotely hosted art or font-dependent emoji. */
export function tutorCharacterPrimitives(
  style: "round" | "book",
  expression: BoardExpression = "quiet",
): CharacterPrimitive[] {
  const ink = "#45404b";
  const output: CharacterPrimitive[] = [];
  const ellipse = (
    x: number,
    y: number,
    rx: number,
    ry: number,
    fill: string,
    stroke?: string,
    lineWidth = 2,
  ): void => {
    output.push({ kind: "ellipse", x, y, rx, ry, fill, stroke, lineWidth });
  };
  const line = (
    points: Array<[number, number]>,
    stroke = ink,
    lineWidth = 2.6,
    closed = false,
    fill?: string,
  ): void => {
    output.push({ kind: "path", points, stroke, lineWidth, closed, fill });
  };
  if (style === "round") {
    ellipse(50, 89, 23, 3, "#ebe6f0");
    ellipse(37, 80, 7, 4, "#f2d6bb", ink);
    ellipse(64, 80, 7, 4, "#f2d6bb", ink);
    ellipse(50, 49, 32, 31, "#fff0d7", ink, 2.6);
    line(
      [
        [40, 18],
        [45, 10],
        [51, 18],
      ],
      ink,
      2.4,
    );
  } else {
    ellipse(50, 89, 27, 3, "#ebe6f0");
    line(
      [
        [20, 29],
        [42, 24],
        [50, 28],
        [58, 24],
        [80, 29],
        [80, 77],
        [58, 72],
        [50, 77],
        [42, 72],
        [20, 77],
      ],
      ink,
      2.6,
      true,
      "#edf4e9",
    );
    line(
      [
        [50, 29],
        [50, 72],
      ],
      "#b8c8b0",
      1.8,
    );
    line(
      [
        [29, 34],
        [41, 32],
      ],
      "#b8c8b0",
      1.6,
    );
    line(
      [
        [60, 32],
        [72, 34],
      ],
      "#b8c8b0",
      1.6,
    );
    line(
      [
        [66, 25],
        [66, 15],
        [73, 18],
        [72, 27],
      ],
      ink,
      1.8,
      true,
      "#efbda8",
    );
    line([
      [37, 76],
      [34, 84],
      [40, 84],
    ]);
    line([
      [64, 76],
      [68, 84],
      [62, 84],
    ]);
  }
  ellipse(31, 57, 5, 2.5, "#edb9b0");
  ellipse(69, 57, 5, 2.5, "#edb9b0");
  const eyes = (left: number, right: number): void => {
    ellipse(38, 47, 2.3, left, ink);
    ellipse(62, 47, 2.3, right, ink);
  };
  switch (expression) {
    case "thinking":
      eyes(2.5, 2.5);
      line(
        [
          [33, 39],
          [42, 37],
        ],
        ink,
        2,
      );
      line(
        [
          [47, 59],
          [54, 59],
        ],
        ink,
        2,
      );
      line([
        [76, 65],
        [64, 65],
        [58, 59],
      ]);
      ellipse(81, 20, 2.2, 2.2, "#b6abd5");
      ellipse(88, 12, 3.2, 3.2, "#b6abd5");
      break;
    case "curious":
      eyes(3, 4);
      ellipse(50, 59, 3, 4, "#fff0d7", ink, 1.8);
      line(
        [
          [82, 13],
          [85, 9],
          [91, 10],
          [94, 14],
          [92, 18],
          [87, 21],
          [87, 24],
        ],
        "#9581b8",
        2.4,
      );
      ellipse(87, 30, 1.4, 1.4, "#9581b8");
      break;
    case "discovery":
      eyes(4, 4);
      line(
        [
          [45, 59],
          [50, 64],
          [56, 58],
        ],
        ink,
        2,
      );
      line(
        [
          [12, 18],
          [12, 29],
        ],
        "#d0a347",
        2.6,
      );
      line(
        [
          [7, 23],
          [17, 23],
        ],
        "#d0a347",
        2.6,
      );
      line(
        [
          [87, 32],
          [87, 42],
        ],
        "#d0a347",
        2.6,
      );
      line(
        [
          [82, 37],
          [92, 37],
        ],
        "#d0a347",
        2.6,
      );
      break;
    case "encouraging":
      line([
        [34, 48],
        [38, 44],
        [42, 48],
      ]);
      line([
        [58, 48],
        [62, 44],
        [66, 48],
      ]);
      line(
        [
          [44, 58],
          [50, 63],
          [57, 57],
        ],
        ink,
        2,
      );
      line(
        [
          [78, 60],
          [86, 53],
          [86, 44],
          [90, 44],
          [92, 56],
          [88, 62],
        ],
        ink,
        2.3,
        false,
      );
      break;
    case "celebrating":
      line([
        [34, 48],
        [38, 44],
        [42, 48],
      ]);
      line([
        [58, 48],
        [62, 44],
        [66, 48],
      ]);
      ellipse(50, 59, 6, 5, "#edb9b0", ink, 1.8);
      line([
        [21, 58],
        [10, 42],
        [8, 35],
      ]);
      line([
        [79, 58],
        [90, 42],
        [92, 35],
      ]);
      line(
        [
          [12, 16],
          [17, 22],
        ],
        "#c39ab6",
        3,
      );
      line(
        [
          [82, 12],
          [78, 19],
        ],
        "#8fae9b",
        3,
      );
      ellipse(30, 9, 2, 2, "#dbb35c");
      ellipse(96, 23, 2, 2, "#dbb35c");
      break;
    case "quiet":
      line(
        [
          [34, 48],
          [38, 50],
          [42, 48],
        ],
        ink,
        2,
      );
      line(
        [
          [58, 48],
          [62, 50],
          [66, 48],
        ],
        ink,
        2,
      );
      line(
        [
          [47, 60],
          [50, 62],
          [54, 60],
        ],
        ink,
        1.8,
      );
      break;
  }
  return output;
}

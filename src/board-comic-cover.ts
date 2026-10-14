import { boardVectorAssetSchema } from "./board-model.js";
import { parseSvgPathData } from "./board-vector.js";
import { DefaultBoardToolRuntime } from "./board-tools.js";
import type { BoardToolEvent, BoardVectorAsset, BoardVectorNode, BoardVectorPaint } from "./board-types.js";

/** A reproducible native-vector challenge, independent of any image provider. */
export type BoardArtworkStage = "composition" | "large-forms" | "ink" | "color" | "texture" | "review";
export const BOARD_ARTWORK_STAGES: readonly BoardArtworkStage[] = ["composition", "large-forms", "ink", "color", "texture", "review"];
export type BoardArtworkPlan = {
  format: "board-artwork-plan-v1";
  id: string;
  title: string;
  artboard: { width: 2048; height: 3072; dpi: 300 };
  style: "original-90s-comic";
  seed: number;
  palette: { paper: string; ink: string; red: string; blue: string; gold: string; cyan: string };
  characters: Array<{ id: "crimson" | "cobalt" | "volt"; name: string; action: string; depth: number; occludes: string[]; requiredParts: string[] }>;
  stages: BoardArtworkStage[];
  stageGoals: Record<BoardArtworkStage, string>;
};
export type BoardArtworkStageEvent = {
  stage: BoardArtworkStage;
  asset: BoardVectorAsset;
  created: string[];
  affected: { x: number; y: number; width: number; height: number };
  warnings: string[];
  elapsedMs: number;
};

const BLACK = "#151321", PAPER = "#F7EBD2", RED = "#DE3A4D", BLUE = "#2E71B8", GOLD = "#F6C34D", CYAN = "#72E7F5";
const IDENT = [1, 0, 0, 1, 0, 0] as const;
type StagedNode = { stage: BoardArtworkStage; node: BoardVectorNode };

export function defaultThreeCharacterArtworkPlan(seed = 1994): BoardArtworkPlan {
  return {
    format: "board-artwork-plan-v1", id: "three-way-collision-1994", title: "NOVA COLLISION", artboard: { width: 2048, height: 3072, dpi: 300 },
    style: "original-90s-comic", seed: seed >>> 0,
    palette: { paper: PAPER, ink: BLACK, red: RED, blue: BLUE, gold: GOLD, cyan: CYAN },
    characters: [
      { id: "cobalt", name: "Cobalt Flux", action: "Lunge from left; blue energy is attached to the right hand", depth: 1, occludes: ["background"], requiredParts: ["head", "front-hair", "back-hair", "face", "torso", "left-arm", "right-arm", "left-leg", "right-leg", "costume", "effect"] },
      { id: "volt", name: "Volt Runner", action: "Vault from right; gold mechanical armor and lightning", depth: 2, occludes: ["background"], requiredParts: ["head", "front-hair", "back-hair", "face", "torso", "left-arm", "right-arm", "left-leg", "right-leg", "costume", "effect"] },
      { id: "crimson", name: "Crimson Arc", action: "Leap toward viewer; oversized foreground gauntlet", depth: 3, occludes: ["background", "cobalt", "volt"], requiredParts: ["head", "front-hair", "back-hair", "face", "torso", "left-arm", "right-arm", "left-leg", "right-leg", "costume", "effect"] },
    ],
    stages: [...BOARD_ARTWORK_STAGES],
    stageGoals: {
      composition: "Three silhouettes converge at the central impact, with a clear cover title and foreground priority",
      "large-forms": "Every fighter has a separately named head, torso, two arms and two legs",
      ink: "Readable faces, action contours and variable-weight dark comic linework",
      color: "Distinct red, blue and gold identities with legible foreground/background separation",
      texture: "Seeded halftone, speed rays, hatching and energy marks stay inside the Artboard",
      review: "Check missing anatomy, empty groups, ordering, export bounds and native editability",
    },
  };
}

export function validateArtworkPlan(plan: BoardArtworkPlan): string[] {
  const warnings: string[] = [];
  if (plan.format !== "board-artwork-plan-v1" || plan.style !== "original-90s-comic") warnings.push("Unsupported artwork plan");
  if (plan.artboard.width !== 2048 || plan.artboard.height !== 3072 || plan.artboard.dpi !== 300) warnings.push("The challenge requires a 2048×3072, 300 DPI artboard");
  const ids = plan.characters.map(character => character.id);
  if (ids.length !== 3 || new Set(ids).size !== 3 || !["crimson", "cobalt", "volt"].every(id => ids.includes(id as typeof ids[number]))) warnings.push("Exactly three distinct challenge characters are required");
  for (const character of plan.characters) {
    if (!character.requiredParts.every(part => /^[a-z-]+$/.test(part))) warnings.push(`Invalid part list for ${character.id}`);
    if (character.occludes.some(target => target === character.id || target !== "background" && !ids.includes(target as typeof ids[number]))) warnings.push(`Invalid occlusion target for ${character.id}`);
    if (character.occludes.some(target => ids.includes(target as typeof ids[number]) && (plan.characters.find(other => other.id === target)?.depth ?? Infinity) >= character.depth)) warnings.push(`Occlusion depth conflict for ${character.id}`);
  }
  if (plan.stages.join(",") !== BOARD_ARTWORK_STAGES.join(",")) warnings.push("Artwork stages are incomplete or reordered");
  if (BOARD_ARTWORK_STAGES.some(stage => !plan.stageGoals[stage]?.trim())) warnings.push("Artwork stage goals are incomplete");
  for (const color of Object.values(plan.palette)) if (!/^#[0-9a-fA-F]{6}$/.test(color)) warnings.push("Palette contains an invalid color");
  return warnings;
}

function solid(color: string, opacity = 1): BoardVectorPaint { return { kind: "solid", color, opacity }; }
function base(id: string, name: string, kind: BoardVectorNode["kind"], parentId?: string, semanticRole?: string): BoardVectorNode {
  return { id, name, kind, ...(parentId ? { parentId } : {}), ...(semanticRole ? { semanticRole } : {}), transform: [...IDENT], opacity: 1, blendMode: "normal", visible: true, locked: false };
}
function rnd(seed: number): () => number { let value = seed >>> 0; return () => { value = (Math.imul(value, 1664525) + 1013904223) >>> 0; return value / 0x100000000; }; }

/** Every visible mark is a named, editable native vector node. */
export function buildThreeCharacterCoverNodes(plan: BoardArtworkPlan): StagedNode[] {
  const issues = validateArtworkPlan(plan); if (issues.length) throw new Error(issues.join("; "));
  const p = plan.palette, nodes: StagedNode[] = [], random = rnd(plan.seed);
  const add = (stage: BoardArtworkStage, node: BoardVectorNode): void => { nodes.push({ stage, node }); };
  const group = (id: string, name: string, role: string, parent?: string): void => add("composition", base(id, name, "group", parent, role));
  const path = (stage: BoardArtworkStage, id: string, name: string, role: string, d: string, fill: string | null, stroke = p.ink, width = 3.5, parent = "scene"): void => {
    add(stage, { ...base(id, name, "path", parent, role), path: parseSvgPathData(d), fill: fill && fill !== "none" ? solid(fill) : { kind: "none" }, ...(stroke !== "none" && width > 0 ? { stroke: { paint: solid(stroke), width, lineCap: "round", lineJoin: "round" } } : {}) });
  };
  const ellipse = (stage: BoardArtworkStage, id: string, name: string, role: string, cx: number, cy: number, rx: number, ry: number, fill: string, stroke = "none", width = 0, parent = "scene"): void => {
    add(stage, { ...base(id, name, "shape", parent, role), shape: { kind: "ellipse", cx, cy, rx, ry }, fill: solid(fill), ...(stroke !== "none" && width > 0 ? { stroke: { paint: solid(stroke), width, lineCap: "round", lineJoin: "round" } } : {}) });
  };
  const line = (stage: BoardArtworkStage, id: string, name: string, role: string, x1: number, y1: number, x2: number, y2: number, color: string, width = 2, parent = "scene"): void => {
    path(stage, id, name, role, `M${x1} ${y1}L${x2} ${y2}`, null, color, width, parent);
  };
  const poly = (stage: BoardArtworkStage, id: string, name: string, role: string, points: number[], fill: string, stroke = p.ink, width = 3, parent = "scene"): void => {
    const d = points.reduce((out, value, index) => out + `${index % 2 ? " " : index ? "L" : "M"}${value}`, "") + "Z";
    path(stage, id, name, role, d, fill, stroke, width, parent);
  };
  group("scene", "NOVA COLLISION / editable cover", "artwork-scene");
  group("backdrop", "City and impact burst", "background", "scene");
  poly("composition", "sky", "Midnight sky", "background-sky", [0,0,800,0,800,1200,0,1200], "#25284A", "none", 0, "backdrop");
  poly("composition", "upper-violet", "Violet diagonal", "background-plane", [0,110,800,0,800,330,0,750], "#634173", "none", 0, "backdrop");
  poly("composition", "lower-cyan", "Blue diagonal", "background-plane", [0,700,800,320,800,1200,0,1200], "#267B9D", "none", 0, "backdrop");
  ellipse("composition", "impact-halo", "Impact disc", "focal-light", 401,570,308,291,"#F2B950","none",0,"backdrop");
  ellipse("color", "impact-core", "Impact light", "focal-light", 402,570,206,198,"#FAEAB4","none",0,"backdrop");
  for (let i=0;i<34;i++) {
    const a=(i/34)*Math.PI*2, b=a+0.035+(i%3)*.008, r1=310, r2=690+(i%4)*70;
    const x=400,y=570;
    poly("texture",`burst-ray-${i}`,`Impact ray ${i+1}`,"speed-ray",[x+Math.cos(a)*r1,y+Math.sin(a)*r1,x+Math.cos(a)*r2,y+Math.sin(a)*r2,x+Math.cos(b)*r2,y+Math.sin(b)*r2],i%3===0?"#FDE7A9":"#F4B84B","none",0,"backdrop");
  }
  // Angular city silhouettes are drawn behind the fighters.
  for (let i=0;i<11;i++) {
    const x=i*81-25,h=120+(i%4)*41,w=70+(i%3)*12;
    poly("large-forms",`city-${i}`,`Building ${i+1}`,"city-building",[x,1115-h,x+w,1115-h,x+w,1200,x,1200],i%2?"#1B2342":"#121B39","none",0,"backdrop");
    for (let j=0;j<3;j++) ellipse("texture",`city-light-${i}-${j}`,`Window ${i+1}-${j+1}`,"city-window",x+17+j*19,1130-h,3,7,"#F3BB5A","none",0,"backdrop");
  }
  // Bounded halftone patches, with a stored seed. These are ordinary editable circles.
  for(let patch=0;patch<3;patch++)for(let row=0;row<12;row++)for(let col=0;col<11;col++){
    const ox=patch===0?35:patch===1?612:180,oy=patch===0?180:patch===1?240:925;
    const x=ox+col*13+(row%2)*6.5,y=oy+row*13;
    const fade=patch===2?1-row/16:1-Math.abs(col-5)/10;
    const radius=1.1+2.5*fade*(.65+random()*.35);
    ellipse("texture",`halftone-${patch}-${row}-${col}`,`Print dot ${patch}-${row}-${col}`,"print-halftone",x,y,radius,radius,patch===1?"#201D41":"#2A244E","none",0,"backdrop");
  }
  // Left fighter: Cobalt Flux. Backward leg and trailing hair establish direction.
  group("cobalt", "COBALT FLUX", "character:cobalt", "scene");
  group("cobalt-back-hair", "Back hair", "back-hair", "cobalt");
  poly("large-forms","cobalt-hair-trail","Windblown hair","back-hair",[173,443,104,458,57,521,95,498,66,569,148,531,205,550,254,473],"#203A72",p.ink,5,"cobalt-back-hair");
  group("cobalt-left-leg","Left leg","left-leg","cobalt");
  path("large-forms","cobalt-thigh-back","Rear thigh","left-leg","M171 743 Q121 780 84 883 L15 958 58 1004 152 941 Q225 864 245 795 Z",p.blue,p.ink,6,"cobalt-left-leg");
  path("color","cobalt-boot-back","Rear boot","left-leg","M15 958 L58 1004 88 998 63 953 Z","#F4F1DC",p.ink,5,"cobalt-left-leg");
  group("cobalt-right-leg","Right leg","right-leg","cobalt");
  path("large-forms","cobalt-thigh-front","Forward thigh","right-leg","M232 750 Q285 786 258 853 L215 989 167 983 174 842 Z","#203C80",p.ink,6,"cobalt-right-leg");
  path("color","cobalt-boot-front","Forward boot","right-leg","M215 970 L233 1050 177 1074 150 1042 168 978 Z","#E9F3E9",p.ink,5,"cobalt-right-leg");
  group("cobalt-torso","Torso","torso","cobalt");
  path("large-forms","cobalt-body","Blue battle coat","torso","M135 592 Q171 566 230 583 L293 688 247 793 149 774 103 682 Z",p.blue,p.ink,7,"cobalt-torso");
  path("color","cobalt-jacket-shadow","Coat shadow","costume","M225 583 L293 688 247 793 207 764 239 679 Z","#174A93","none",0,"cobalt-torso");
  path("color","cobalt-chest-panel","Chest armor","costume","M151 620 L228 606 252 686 219 740 153 710 Z","#BDE9E9",p.ink,4,"cobalt-torso");
  path("ink","cobalt-coat-tail","Trailing coat seam","costume","M119 670 Q90 730 34 802 M150 710 Q127 748 110 779",null,p.ink,4,"cobalt-torso");
  group("cobalt-left-arm","Left arm","left-arm","cobalt");
  path("large-forms","cobalt-left-sleeve","Outstretched left arm","left-arm","M127 601 Q76 620 35 577 L2 538 13 489 82 520 161 558 Z",p.blue,p.ink,6,"cobalt-left-arm");
  path("color","cobalt-left-glove","Left glove","left-arm","M2 538 L13 489 36 486 51 513 32 551 Z","#E9F1EF",p.ink,5,"cobalt-left-arm");
  group("cobalt-head","Head","head","cobalt");
  path("large-forms","cobalt-neck","Neck","head","M172 562 L177 528 218 538 229 582 196 609 Z","#F1B68B",p.ink,5,"cobalt-head");
  path("large-forms","cobalt-face","Face","face","M156 457 Q186 427 220 455 Q246 482 226 537 L204 557 172 540 Q148 507 156 457 Z","#F6BE96",p.ink,5,"cobalt-head");
  group("cobalt-front-hair","Front hair","front-hair","cobalt-head");
  path("color","cobalt-hair-top","Jagged front hair","front-hair","M146 467 Q155 418 202 424 L257 442 232 452 252 464 217 463 207 492 189 469 163 494 Z","#253D76",p.ink,5,"cobalt-front-hair");
  path("ink","cobalt-eye","Focused eye","face","M172 505 Q185 493 199 497 M211 499 Q223 492 232 495",null,p.ink,3,"cobalt-head");
  path("ink","cobalt-mouth","Grim mouth","face","M196 531 Q206 535 215 529",null,p.ink,2.5,"cobalt-head");
  group("cobalt-right-arm","Right arm","right-arm","cobalt");
  path("large-forms","cobalt-right-sleeve","Punching sleeve","right-arm","M232 595 Q278 576 317 591 L389 544 417 580 326 653 269 671 Z",p.blue,p.ink,6,"cobalt-right-arm");
  path("color","cobalt-forearm-plate","Forearm plate","costume","M315 595 L389 544 417 580 345 634 Z","#B8E8EE",p.ink,4,"cobalt-right-arm");
  path("large-forms","cobalt-fist","Energy fist","right-arm","M391 536 Q420 519 439 543 L455 574 429 600 396 596 378 571 Z","#E8F2EF",p.ink,5,"cobalt-right-arm");
  group("cobalt-effect","Cyan energy","effect","cobalt");
  path("color","cobalt-energy-main","Arc current","effect","M432 555 Q383 467 346 441 L371 466 Q306 450 280 411 L300 464 Q355 479 378 519 Z",p.cyan,"#173B68",4,"cobalt-effect");
  path("texture","cobalt-energy-ribbon","Electric ribbon","effect","M405 580 Q339 561 321 522 M413 522 Q466 468 450 407 M447 585 L488 617",null,"#F1FFFF",5,"cobalt-effect");
  // Right fighter: Volt Runner. Angular armor and independent limb groups.
  group("volt", "VOLT RUNNER", "character:volt", "scene");
  group("volt-back-hair","Back hair","back-hair","volt");
  poly("large-forms","volt-hair-tail","Black hair tail","back-hair",[590,531,657,516,722,581,766,614,704,612,748,682,659,639],"#1D1C35",p.ink,5,"volt-back-hair");
  group("volt-right-leg","Right leg","right-leg","volt");
  path("large-forms","volt-rear-leg","Rear leg","right-leg","M639 759 Q700 795 714 873 L790 941 760 989 647 920 Q579 850 568 789 Z","#1F273F",p.ink,7,"volt-right-leg");
  path("color","volt-rear-boot","Rear boot","right-leg","M760 960 L800 966 798 1025 750 1013 731 988 Z",p.gold,p.ink,5,"volt-right-leg");
  group("volt-left-leg","Left leg","left-leg","volt");
  path("large-forms","volt-front-leg","Front leg","left-leg","M569 745 Q524 787 493 831 L441 917 485 950 567 888 643 795 Z",p.gold,p.ink,7,"volt-left-leg");
  path("color","volt-front-boot","Front boot","left-leg","M441 917 L485 950 466 1012 407 1000 398 973 Z","#25304B",p.ink,5,"volt-left-leg");
  group("volt-torso","Torso","torso","volt");
  path("large-forms","volt-body","Mechanical torso","torso","M559 602 L644 589 692 666 646 802 548 790 507 676 Z",p.gold,p.ink,7,"volt-torso");
  path("color","volt-chest-black","Black chest plate","costume","M556 630 L637 612 663 673 628 741 565 728 527 677 Z","#25283B",p.ink,5,"volt-torso");
  poly("color","volt-chest-bolt","Chest bolt","costume",[585,646,620,634,609,677,635,675,585,718,601,679,573,681],"#FBE398",p.ink,2.5,"volt-torso");
  path("ink","volt-armor-seams","Armor segment seams","costume","M551 746 Q598 762 663 731 M541 688 L565 728 M649 609 L672 656",null,"#FCE290",3,"volt-torso");
  group("volt-right-arm","Right arm","right-arm","volt");
  path("large-forms","volt-right-sleeve","Raised right arm","right-arm","M649 611 Q693 574 706 524 L748 462 780 481 747 565 Q727 636 674 674 Z",p.gold,p.ink,6,"volt-right-arm");
  path("color","volt-right-plate","Right armor plate","costume","M706 526 L748 462 780 481 749 555 Z","#20263B",p.ink,4,"volt-right-arm");
  path("large-forms","volt-right-hand","Right hand","right-arm","M751 458 L772 434 791 445 798 481 777 501 747 485 Z","#F5BF8B",p.ink,5,"volt-right-arm");
  group("volt-head","Head","head","volt");
  path("large-forms","volt-neck","Neck","head","M588 594 L591 565 624 563 635 608 608 626 Z","#ECA572",p.ink,4,"volt-head");
  path("large-forms","volt-face","Face","face","M566 510 Q589 480 620 490 Q650 511 639 556 L607 585 573 563 Q556 539 566 510 Z","#F4B785",p.ink,5,"volt-head");
  group("volt-front-hair","Front hair","front-hair","volt-head");
  poly("color","volt-hair-visor","Angular hair and visor","front-hair",[556,523,567,478,604,460,655,480,663,510,638,498,630,529,605,508,578,536],"#242238",p.ink,5,"volt-front-hair");
  path("color","volt-goggles","Gold visor","face","M573 531 Q606 508 634 523 L631 544 Q604 537 578 552 Z","#E9CF6A",p.ink,4,"volt-head");
  path("ink","volt-mouth","Determined mouth","face","M591 562 Q605 565 617 555",null,p.ink,2.5,"volt-head");
  group("volt-left-arm","Left arm","left-arm","volt");
  path("large-forms","volt-left-sleeve","Crossing left arm","left-arm","M536 616 Q514 604 492 616 L420 677 443 711 530 676 563 665 Z",p.gold,p.ink,6,"volt-left-arm");
  path("color","volt-left-plate","Left forearm plate","costume","M492 617 L420 677 443 711 520 669 Z","#25283E",p.ink,4,"volt-left-arm");
  path("large-forms","volt-left-fist","Left fist","left-arm","M409 674 L442 665 459 684 451 716 419 728 401 708 Z","#EFB480",p.ink,5,"volt-left-arm");
  group("volt-effect","Lightning","effect","volt");
  poly("color","volt-bolt-upper","Golden lightning","effect",[755,422,716,461,736,462,701,511,743,488,730,504,780,473,755,475],"#FFF1A4","#B9514E",3,"volt-effect");
  poly("color","volt-bolt-left","Crossing lightning","effect",[435,692,387,661,403,685,347,667,391,719,377,700,428,741],"#FFE177","#AB5552",3,"volt-effect");
  // Central fighter: Crimson Arc. A deep foreshortened foreground gauntlet dominates.
  group("crimson", "CRIMSON ARC", "character:crimson", "scene");
  group("crimson-back-hair","Back hair","back-hair","crimson");
  poly("large-forms","crimson-hair-tail","Wind-whipped black hair","back-hair",[335,350,307,339,240,373,273,329,225,340,292,286,371,304,434,357],"#1B1B39",p.ink,6,"crimson-back-hair");
  group("crimson-left-leg","Left leg","left-leg","crimson");
  path("large-forms","crimson-left-thigh","Forward left thigh","left-leg","M379 697 Q351 743 327 818 L272 960 326 994 412 894 Q460 839 471 774 Z",p.red,p.ink,8,"crimson-left-leg");
  path("color","crimson-left-knee","Left knee armor","costume","M327 818 Q370 815 407 848 L372 891 315 879 Z","#F4D9BE",p.ink,5,"crimson-left-leg");
  path("color","crimson-left-boot","Left boot","left-leg","M272 960 L326 994 311 1085 247 1111 209 1083 227 1024 Z","#A32643",p.ink,7,"crimson-left-leg");
  path("ink","crimson-boot-lines","Boot seams","costume","M231 1025 L294 1048 M259 1075 L307 1063",null,"#F6B5A5",3,"crimson-left-leg");
  group("crimson-right-leg","Right leg","right-leg","crimson");
  path("large-forms","crimson-right-thigh","Bent right thigh","right-leg","M457 692 Q524 693 566 742 L611 848 553 885 463 812 419 784 Z","#9B1D3D",p.ink,8,"crimson-right-leg");
  path("color","crimson-right-boot","Right boot","right-leg","M552 849 L611 848 685 939 674 983 602 989 548 926 Z",p.red,p.ink,7,"crimson-right-leg");
  path("ink","crimson-right-boot-seam","Right boot seam","costume","M568 895 L627 897 M596 935 L660 938",null,"#FFCAB1",3,"crimson-right-leg");
  group("crimson-cape","Cape","costume","crimson");
  path("large-forms","crimson-cape-base","Whipping cape","costume","M370 473 Q315 415 250 450 L83 365 123 419 34 441 204 462 286 513 380 540 Z","#9E2045",p.ink,7,"crimson-cape");
  path("color","crimson-cape-light","Cape highlight","costume","M285 471 Q232 449 114 394 L155 436 Q228 472 287 494 Z","#E84C62","none",0,"crimson-cape");
  group("crimson-torso","Torso","torso","crimson");
  path("large-forms","crimson-body","Twisting armored torso","torso","M351 472 Q402 450 464 474 L512 582 474 727 391 754 330 630 Z",p.red,p.ink,9,"crimson-torso");
  path("color","crimson-body-shadow","Torso shadow","costume","M457 474 L512 582 474 727 427 742 455 629 Z","#8E1C3D","none",0,"crimson-torso");
  path("color","crimson-chest-plating","Ivory chest armor","costume","M361 501 L408 524 457 490 482 551 432 636 375 609 Z","#F3DECA",p.ink,6,"crimson-torso");
  poly("color","crimson-emblem","Original diagonal crest","costume",[393,548,435,564,414,586,451,602,421,633,380,603,402,584,374,574],"#E04D5C",p.ink,3,"crimson-torso");
  path("ink","crimson-belt","Segmented belt","costume","M371 691 Q424 713 484 679 M390 696 L389 724 M432 705 L437 731",null,p.ink,5,"crimson-torso");
  group("crimson-left-arm","Left arm","left-arm","crimson");
  path("large-forms","crimson-left-upper","Sweeping left arm","left-arm","M349 500 Q311 483 281 510 L224 607 260 644 355 567 Z",p.red,p.ink,7,"crimson-left-arm");
  path("color","crimson-left-glove","Left armored glove","left-arm","M224 607 L260 644 224 702 185 688 175 645 Z","#F2DDC8",p.ink,6,"crimson-left-arm");
  path("ink","crimson-left-glove-seam","Glove seam","costume","M192 652 L240 668 M200 681 L229 683",null,p.ink,3,"crimson-left-arm");
  group("crimson-head","Head","head","crimson");
  path("large-forms","crimson-neck","Neck","head","M375 470 L378 440 421 438 443 478 407 507 Z","#E8A77F",p.ink,5,"crimson-head");
  path("large-forms","crimson-face","Face","face","M350 352 Q372 308 417 326 Q451 348 442 415 L415 458 380 452 Q344 425 350 352 Z","#F3B58E",p.ink,6,"crimson-head");
  path("color","crimson-mask","Angular red eye mask","face","M352 376 Q381 356 407 370 Q425 357 444 375 L437 400 Q421 391 409 404 Q378 388 354 410 Z","#A62042",p.ink,4,"crimson-head");
  group("crimson-front-hair","Front hair","front-hair","crimson-head");
  poly("color","crimson-fringe","Blade-shaped front hair","front-hair",[341,382,331,340,367,303,415,298,458,327,465,366,437,352,428,384,408,344,384,385,366,368],"#1D1B38",p.ink,6,"crimson-front-hair");
  path("ink","crimson-eyes","Sharp eyes","face","M367 390 Q382 382 396 389 M411 387 Q424 379 436 385 M382 393 L392 394 M418 390 L429 390",null,"#FFF1D9",3.5,"crimson-head");
  poly("color","crimson-left-eye-white","Left anime eye","face",[368,390,383,385,397,391,385,399],"#FFF9E6",p.ink,2,"crimson-head");
  poly("color","crimson-right-eye-white","Right anime eye","face",[410,389,424,383,436,387,425,397],"#FFF9E6",p.ink,2,"crimson-head");
  ellipse("ink","crimson-left-pupil","Left pupil","face",386,392,3,5,p.ink,"none",0,"crimson-head");
  ellipse("ink","crimson-right-pupil","Right pupil","face",422,389,3,5,p.ink,"none",0,"crimson-head");
  path("ink","crimson-nose-mouth","Nose and expression","face","M403 400 L397 421 408 424 M390 439 Q406 446 420 435",null,p.ink,3,"crimson-head");
  group("crimson-right-arm","Right arm / foreground","right-arm","crimson");
  path("large-forms","crimson-right-shoulder","Right shoulder","right-arm","M453 491 Q505 465 541 503 L598 555 561 625 494 595 Z",p.red,p.ink,8,"crimson-right-arm");
  path("color","crimson-right-forearm","Foreshortened forearm","right-arm","M537 522 L598 555 643 612 604 692 536 638 508 593 Z","#AD284A",p.ink,7,"crimson-right-arm");
  path("large-forms","crimson-gauntlet","Oversized foreground gauntlet","right-arm","M595 564 Q651 536 695 563 L743 615 Q756 685 704 736 L636 752 575 711 565 647 Z","#F2D8BF",p.ink,10,"crimson-right-arm");
  path("color","crimson-gauntlet-red","Gauntlet red shield","costume","M591 604 Q640 573 696 597 L727 645 706 700 652 724 605 684 Z",p.red,p.ink,6,"crimson-right-arm");
  path("ink","crimson-gauntlet-fingers","Fist knuckle segments","right-arm","M606 626 Q646 611 691 635 M618 658 Q659 644 708 664 M641 696 L658 718 M679 696 L687 714",null,p.ink,5,"crimson-right-arm");
  path("texture","crimson-gauntlet-glint","White armor glint","effect","M613 591 Q664 572 704 610 M593 639 L608 608",null,"#FFF7DB",4,"crimson-right-arm");
  group("crimson-effect","Impact and sparks","effect","crimson");
  path("color","crimson-scarf-spark","Red arc afterimage","effect","M565 649 Q516 715 507 794 M585 559 Q549 478 487 436",null,"#FCE7B3",7,"crimson-effect");
  for(let i=0;i<11;i++){
    line("texture",`crimson-torso-hatch-${i}`,`Torso crosshatch ${i+1}`,"ink-hatching",345+i*3,636+i*2,358+i*3,626+i*2,p.ink,1.5,"crimson-torso");
    line("texture",`cobalt-coat-hatch-${i}`,`Blue coat crosshatch ${i+1}`,"ink-hatching",157+i*4,727+i*.8,166+i*4,717+i*.8,"#0D2B5C",1.4,"cobalt-torso");
    line("texture",`volt-armor-hatch-${i}`,`Gold armor crosshatch ${i+1}`,"ink-hatching",568+i*4,744-i*.8,577+i*4,737-i*.8,p.ink,1.4,"volt-torso");
  }
  path("texture","cobalt-hair-strands","Windblown hair strands","front-hair","M126 452 Q187 419 226 443 M118 474 Q147 452 174 453 M212 429 L243 447",null,"#70A5D7",2.3,"cobalt-front-hair");
  path("texture","volt-hair-strands","Black hair highlights","front-hair","M573 489 Q602 470 639 487 M622 481 L650 499",null,"#6B6489",2.5,"volt-front-hair");
  path("texture","crimson-hair-strands","Black hair highlights","front-hair","M353 331 Q387 304 428 321 M387 329 L450 338",null,"#6D668A",2.5,"crimson-front-hair");
  // Final ink, editorial lettering and trim.
  for(let i=0;i<30;i++){
    const a=(i/30)*Math.PI*2, inner=130+(i%4)*13, outer=240+(i%5)*18;
    const x=414+Math.cos(a)*inner,y=648+Math.sin(a)*inner;
    line("texture",`impact-speed-${i}`,`Impact line ${i+1}`,"speed-line",x,y,414+Math.cos(a)*outer,648+Math.sin(a)*outer,i%4===0?"#FCF3D9":p.ink,i%3===0?4:2,"scene");
  }
  poly("review","bottom-banner","Bottom caption panel","lettering",[26,1120,774,1120,756,1182,40,1182],"#F6D566",p.ink,5,"scene");
  const text = (id:string,value:string,x:number,y:number,size:number,color:string,parent:string):void => add("review",{...base(id,value,"text",parent,"lettering"),text:{value,x,y,style:{font:"sans",size,align:"left"}},fill:solid(color)});
  text("cover-title","NOVA COLLISION",35,91,58,"#FFF2D4","scene");
  text("cover-edition","THREE HEROES  ·  ONE IMPACT",54,1161,27,p.ink,"scene");
  path("review","cover-title-rule","Title underline","lettering","M38 105 L757 105",null,"#EBC967",5,"scene");
  poly("review","top-right-badge","Issue badge","lettering",[681,24,769,24,769,72,681,72],"#F4CD57",p.ink,4,"scene");
  text("issue-text","01",701,60,30,p.ink,"scene");
  poly("review","border","Print border","trim",[9,9,791,9,791,1191,9,1191],"none",p.ink,12,"scene");
  const cobalt = nodes.find(entry => entry.node.id === "cobalt"), volt = nodes.find(entry => entry.node.id === "volt"), crimson = nodes.find(entry => entry.node.id === "crimson");
  if (cobalt) cobalt.node.transform = [1, 0, 0, 1, -34, 18];
  if (volt) volt.node.transform = [1, 0, 0, 1, 77, -28];
  if (crimson) crimson.node.transform = [.9, 0, 0, .9, 39, 71];
  return nodes;
}

export function compileThreeCharacterCover(plan: BoardArtworkPlan, through: BoardArtworkStage = "review"): BoardVectorAsset {
  const limit = BOARD_ARTWORK_STAGES.indexOf(through); if (limit < 0) throw new Error("Unknown artwork stage");
  const selected = buildThreeCharacterCoverNodes(plan).filter(entry => BOARD_ARTWORK_STAGES.indexOf(entry.stage) <= limit);
  return boardVectorAssetSchema.parse({ format: "board-vector-v1", id: `${plan.id}-vector`, version: 1, name: plan.title, width: 800, height: 1200, rootIds: ["scene"], nodes: selected.map(entry => entry.node), createdAt: "2026-09-24T00:00:00.000Z" });
}

export function inspectThreeCharacterCover(asset: BoardVectorAsset, plan: BoardArtworkPlan): { valid: boolean; warnings: string[]; editablePartRatio: number } {
  const roles = new Set(asset.nodes.map(node => node.semanticRole).filter(Boolean));
  const warnings = validateArtworkPlan(plan);
  for (const character of plan.characters) {
    if (!roles.has(`character:${character.id}`)) warnings.push(`Missing character ${character.name}`);
    const root = asset.nodes.find(node => node.semanticRole === `character:${character.id}`);
    const descendants = root ? asset.nodes.filter(node => { let parent = node.parentId; while (parent) { if (parent === root.id) return true; parent = asset.nodes.find(candidate => candidate.id === parent)?.parentId; } return false; }) : [];
    for (const part of character.requiredParts) if (!descendants.some(node => node.semanticRole === part)) warnings.push(`${character.name}: missing ${part}`);
  }
  const visible = asset.nodes.filter(node => node.kind !== "group");
  const named = visible.filter(node => !!node.semanticRole && !!node.name);
  return { valid: warnings.length === 0, warnings, editablePartRatio: visible.length ? named.length / visible.length : 0 };
}

/** Stage batches run through the same validator and rollback boundary as model tools. */
export async function createThreeCharacterCoverSession(plan: BoardArtworkPlan, options: { signal?: AbortSignal; onStage?: (event: BoardArtworkStageEvent) => void | Promise<void> } = {}): Promise<BoardVectorAsset> {
  const entries = buildThreeCharacterCoverNodes(plan);
  const runtime = new DefaultBoardToolRuntime();
  const seed: BoardVectorAsset = { format: "board-vector-v1", id: `${plan.id}-vector`, version: 1, name: plan.title, width: 800, height: 1200, rootIds: ["scene"], nodes: [entries[0]!.node], createdAt: "2026-09-24T00:00:00.000Z" };
  const { transactionId } = await runtime.beginTransaction({ artboardId: plan.id, baseRevision: 0, asset: seed });
  const started = performance.now();
  try {
    for (const stage of BOARD_ARTWORK_STAGES) {
      if (options.signal?.aborted) throw new DOMException("Artwork cancelled", "AbortError");
      const current = entries.filter(entry => entry.stage === stage && entry.node.id !== "scene").map(entry => entry.node);
      for (let offset = 0; offset < current.length; offset += 128) {
        if (options.signal?.aborted) throw new DOMException("Artwork cancelled", "AbortError");
        const batch = current.slice(offset, offset + 128);
        for await (const _event of runtime.call(transactionId, { name: "node.create", arguments: { nodes: batch } })) { /* validated per batch */ }
      }
      // Node creation is staged for previews; restore authored sibling z-order
      // so later color batches remain beneath ink rather than painting it out.
      for (const parentId of new Set(current.map(node => node.parentId).filter((id): id is string => !!id))) {
        const present = entries.filter(entry => BOARD_ARTWORK_STAGES.indexOf(entry.stage) <= BOARD_ARTWORK_STAGES.indexOf(stage) && entry.node.parentId === parentId).map(entry => entry.node.id);
        if (present.length < 2 || present.length > 256) continue;
        for await (const _event of runtime.call(transactionId, { name: "node.reorder", arguments: { parentId, ids: present } })) { /* order validated by runtime */ }
      }
      const checkpoint = await runtime.checkpoint(transactionId);
      const result = inspectThreeCharacterCover(checkpoint.asset, plan);
      await options.onStage?.({ stage, asset: checkpoint.asset, created: current.map(node => node.id), affected: { x: 0, y: 0, width: 800, height: 1200 }, warnings: [...checkpoint.warnings, ...(stage === "review" ? result.warnings : [])], elapsedMs: Math.round(performance.now() - started) });
    }
    const result = await runtime.commit(transactionId);
    return result.asset;
  } catch (error) { await runtime.rollback(transactionId); throw error; }
}

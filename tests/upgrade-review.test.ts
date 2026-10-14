import {it,expect,vi,beforeEach} from "vitest";
import type {ReviewCard} from "../src/views/review-modal.js";
import {initReviewState,type ReviewGrade} from "../src/srs.js";
const {modals}=vi.hoisted(()=>({modals:[] as Array<{cards:ReviewCard[];grade:(card:ReviewCard,grade:ReviewGrade)=>Promise<void>}>}));
vi.mock("obsidian",()=>({Notice:class{hide(){}}}));
vi.mock("../src/views/review-modal.js",()=>({ReviewModal:class{constructor(_app:unknown,cards:ReviewCard[],handlers:{grade:(card:ReviewCard,grade:ReviewGrade)=>Promise<void>}){modals.push({cards,...handlers});}open(){}},setDueBadge:()=>{}}));
import {ReviewController,type ReviewDeps} from "../src/review-controller.js";
function fixture(){const cell={id:"cell-1",path:"cell.md",concept:"Limits",summary:"fixture",review:initReviewState("2026-01-01T00:00:00.000Z")};const save=vi.fn(async()=>{});const controller=new ReviewController({app:{},store:{updateCellSchedule:save},cells:()=>[cell],settings:()=>({enableSpacedReview:true}),statusBar:{},openPath:async()=>{}} as unknown as ReviewDeps);return {cell,save,controller};}
beforeEach(()=>modals.length=0);
it("two simultaneously open review cards submit one scheduling event",async()=>{const {save,controller,cell}=fixture();await controller.reviewDueCells();await controller.reviewDueCells();await Promise.all(modals.map(m=>m.grade(m.cards[0]!,"good")));expect(save).toHaveBeenCalledTimes(1);expect(cell.review.reps).toBe(1);await modals[0]!.grade(modals[0]!.cards[0]!,"easy");expect(save).toHaveBeenCalledTimes(1);});
it("failed persistence does not award repetitions and allows a retry",async()=>{const {save,controller,cell}=fixture();save.mockRejectedValueOnce(new Error("disk failed"));await controller.reviewDueCells();const m=modals[0]!;await expect(m.grade(m.cards[0]!,"good")).rejects.toThrow("disk failed");expect(cell.review.reps).toBe(0);await m.grade(m.cards[0]!,"good");expect(cell.review.reps).toBe(1);});

import { describe, expect, it, vi } from "vitest";
import { LearningInvalidation, LearningSessionReferences, learningScopeAffected } from "../src/learning-invalidation.js";
import type { LearningContextSnapshot } from "../src/learning-context.js";
const snapshot:LearningContextSnapshot={version:1,revision:"1",summary:"evidence",episodes:[{id:"one",source:"actual.md",format:2,revision:1,concept:"value-limit",evidenceIds:[]}]};

describe("learning reader invalidation", () => {
  it("cancels related readers once and leaves other documents running", () => {
    const readers = new LearningInvalidation(), a = vi.fn(), b = vi.fn();
    readers.track({ source: "a.md" }, a); readers.track({ source: "b.md" }, b);
    readers.changed({ recordId: "a", sources: ["a.md"], unknownScope: false });
    readers.changed({ recordId: "a", sources: ["a.md"], unknownScope: false });
    expect(a).toHaveBeenCalledTimes(1); expect(b).not.toHaveBeenCalled();
  });
  it("disposes completed reads, but invalidates unknown damaged evidence conservatively", () => {
    const readers = new LearningInvalidation(), completed = vi.fn(), active = vi.fn();
    readers.track({ source: "a.md" }, completed)(); readers.track({ source: "b.md" }, active);
    readers.changed({ sources: [], unknownScope: true });
    expect(completed).not.toHaveBeenCalled(); expect(active).toHaveBeenCalledTimes(1);
  });
  it("honors explicit episode identity and authorized source scope", () => {
    const change = { recordId: "one", sources: ["private.md"], unknownScope: false };
    expect(learningScopeAffected({ episodeId: "two" }, change)).toBe(false);
    expect(learningScopeAffected({ episodeId: "one", allowedSources: ["public.md"] }, change)).toBe(false);
    expect(learningScopeAffected({ episodeId: "one", allowedSources: ["private.md"] }, change)).toBe(true);
    expect(learningScopeAffected({}, { sources: [], unknownScope: true })).toBe(false);
  });
  it("matches a source rename against the actual source of an explicitly selected episode",()=>{
    const readers=new LearningInvalidation(),cancel=vi.fn();
    readers.track({source:"display.md",episodeId:"one"},cancel,{snapshot});
    readers.changed({sources:["display.md","renamed-display.md"],unknownScope:false});expect(cancel).not.toHaveBeenCalled();
    readers.changed({sources:["actual.md","renamed-actual.md"],unknownScope:false});expect(cancel).toHaveBeenCalledOnce();
  });
  it("excludes only the committing request while cancelling other readers of its evidence",()=>{
    const readers=new LearningInvalidation(),own=vi.fn(),other=vi.fn(),unrelated=vi.fn();
    readers.track({source:"actual.md"},own,{snapshot,requestId:"commit"});
    readers.track({source:"actual.md"},other,{snapshot,requestId:"other"});
    readers.track({source:"other.md"},unrelated,{requestId:"third"});
    readers.changed({recordId:"one",sources:["actual.md"],unknownScope:false,requestId:"commit"});
    expect(own).not.toHaveBeenCalled();expect(other).toHaveBeenCalledOnce();expect(unrelated).not.toHaveBeenCalled();
    readers.changed({recordId:"one",sources:["actual.md"],unknownScope:false});expect(own).toHaveBeenCalledOnce();
  });
  it("tracks cached evidence rather than empty ordinary questions, and clears replaced sessions",()=>{
    const references=new LearningSessionReferences();
    references.remember({source:"empty.md"},{...snapshot,summary:"",episodes:[]});
    expect(references.affected({sources:["empty.md"],unknownScope:false})).toBe(false);
    references.remember({source:"display.md",episodeId:"one"},snapshot);
    expect(references.affected({sources:["actual.md"],unknownScope:false})).toBe(true);
    expect(references.affected({sources:["display.md"],unknownScope:false})).toBe(false);
    references.clear();expect(references.affected({sources:[],unknownScope:true})).toBe(false);
  });
});

import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { migrateSettings } from "../src/settings-config.js";
import { CredentialSettingsSession, credentialBinding, credentialStatusFor } from "../src/credential-session.js";
import type { CredentialReference, CredentialSlot } from "../src/credential-types.js";
import type { CredentialStore } from "../src/credential-store.js";
import { boardConnectionKey, resolveBoardConnection } from "../src/board-connection.js";

function fixture(raw:Record<string,unknown>={},available=true) {
  const settings=migrateSettings(raw),records=new Map<string,string>(),events:string[]=[];
  let disk=structuredClone(raw),enabled=available;
  const store:CredentialStore={available:()=>enabled,put:vi.fn(async(slot:CredentialSlot,binding:string,value:string)=>{
    events.push(`secure-write:${slot}`);const ref:CredentialReference={version:1,id:randomUUID(),slot,binding};records.set(ref.id,value);return ref;
  }),get:vi.fn(async(ref:CredentialReference)=>{events.push(`secure-read:${ref.slot}`);const value=records.get(ref.id);if(value===undefined)throw Error("missing");return value;})};
  const write=vi.fn(async(value:Record<string,unknown>)=>{events.push("settings-reference-write");disk=structuredClone(value);});
  const session=new CredentialSettingsSession(settings,store,{write});
  return {settings,records,store,write,session,events,disk:()=>disk,setAvailable:(value:boolean)=>{enabled=value;}};
}
describe("credential migration and session compatibility",()=>{
  it("writes and verifies every secret before committing references, omitting plaintext",async()=>{
    const secrets={apiKey:"API-FIXTURE",boardImageApiKey:"IMAGE-FIXTURE",tutorRemoteToken:"REMOTE-FIXTURE",mcpServersJson:'{"mcpServers":{"x":{"command":"node","env":{"TOKEN":"MCP-FIXTURE"}}}}'};
    const f=fixture({...secrets,webBridgeToken:"OLD-SHARED-FIXTURE",apiModel:"chosen-model",boardImageUseSharedApiKey:false});
    expect((await f.session.initialize()).state).toBe("ready");
    expect(f.events.at(-1)).toBe("settings-reference-write");expect(f.events).toHaveLength(9);
    for(const [slot,value] of Object.entries(secrets)){
      expect(f.settings[slot as CredentialSlot]).toBe(value);
      expect(Object.keys(f.settings)).not.toContain(slot);expect(JSON.stringify(f.disk())).not.toContain(value);
    }
    expect(f.settings.credentialRefs).toHaveLength(4);expect(f.disk().apiModel).toBe("chosen-model");expect(f.disk().webBridgeToken).toBe("");
    expect(credentialStatusFor(f.settings)?.state).toBe("ready");
  });
  it.each(["write","readback","settings"])("keeps the original configuration and connection after %s failure",async step=>{
    const f=fixture({apiKey:"LEGACY-FAILURE-FIXTURE",apiModel:"same-model"});
    if(step==="write")vi.mocked(f.store.put).mockRejectedValueOnce(Error("provider message must not escape"));
    if(step==="readback")vi.mocked(f.store.get).mockResolvedValueOnce("WRONG-READBACK");
    if(step==="settings")f.write.mockRejectedValueOnce(Error("disk error with sensitive details"));
    expect((await f.session.initialize()).state).toBe("migration-pending");
    expect(f.disk()).toEqual({apiKey:"LEGACY-FAILURE-FIXTURE",apiModel:"same-model"});
    expect(f.settings.apiKey).toBe("LEGACY-FAILURE-FIXTURE");expect(f.settings.credentialRefs).toEqual([]);
    expect((await f.session.save()).state).toBe("ready");expect(f.disk().apiKey).toBeUndefined();
  });
  it("never rewrites an unmigrated legacy file while system encryption is unavailable",async()=>{
    const f=fixture({apiKey:"LEGACY-UNAVAILABLE-FIXTURE"},false);
    expect((await f.session.initialize()).state).toBe("migration-pending");
    f.settings.apiModel="changed-in-memory";
    await expect(f.session.save()).rejects.toThrow("credential-migration-pending");
    expect(f.write).not.toHaveBeenCalled();expect(f.settings.apiKey).toBe("LEGACY-UNAVAILABLE-FIXTURE");
  });
  it("keeps a newly entered key only in the session when encryption is unavailable",async()=>{
    const f=fixture({},false);await f.session.initialize();f.settings.apiKey="SESSION-FIXTURE";
    expect((await f.session.save()).state).toBe("session-only");expect(f.settings.apiKey).toBe("SESSION-FIXTURE");
    expect(JSON.stringify(f.disk())).not.toContain("SESSION-FIXTURE");expect(f.disk().apiKey).toBeUndefined();
    const reopened=fixture(f.disk(),false);await reopened.session.initialize();expect(reopened.settings.apiKey).toBe("");
    f.setAvailable(true);expect((await f.session.save()).state).toBe("ready");expect(f.settings.credentialRefs).toHaveLength(1);
  });
  it("isolates credentials by provider and restores each selected provider without copying keys",async()=>{
    const f=fixture({apiBaseUrl:"https://provider-a.test/v1",apiKey:"PROVIDER-A-FIXTURE"});await f.session.initialize();
    f.settings.apiBaseUrl="https://provider-b.test/v1";expect(f.settings.apiKey).toBe("");
    f.settings.apiKey="PROVIDER-B-FIXTURE";await f.session.save();
    f.settings.apiBaseUrl="https://provider-a.test/v1";expect(f.settings.apiKey).toBe("PROVIDER-A-FIXTURE");
    expect(f.settings.credentialRefs).toHaveLength(2);
    expect(f.settings.credentialRefs[0]?.binding).not.toBe(f.settings.credentialRefs[1]?.binding);
    f.settings.boardImageBaseUrl=f.settings.apiBaseUrl;expect(f.settings.boardImageApiKey).toBe("");
  });
  it("keeps connection routing and invalidation compatible with non-enumerable runtime secrets",async()=>{
    const f=fixture({chatEngine:"api",apiKey:"ROUTE-FIRST-FIXTURE",apiModel:"same-model"});await f.session.initialize();
    const route=resolveBoardConnection(f.settings),before=boardConnectionKey(f.settings);
    expect(resolveBoardConnection({...f.settings})).toEqual(route);
    expect({...f.settings}).not.toHaveProperty("apiKey");
    expect({...route,apiKey:f.settings.apiKey}).toEqual({...route,apiKey:"ROUTE-FIRST-FIXTURE"});
    f.settings.apiKey="ROUTE-SECOND-FIXTURE";
    expect(resolveBoardConnection(f.settings)).toEqual(route);expect(boardConnectionKey(f.settings)).not.toBe(before);
    f.settings.chatEngine="opencode";const agentBefore=boardConnectionKey(f.settings);
    f.settings.mcpServersJson='{"mcpServers":{"fixture":{"command":"node","env":{"TOKEN":"MCP-ROUTE-FIXTURE"}}}}';
    expect(boardConnectionKey(f.settings)).not.toBe(agentBefore);
  });
  it("preserves unresolved cross-device references without substituting another host's key",async()=>{
    const origin=fixture({apiKey:"DEVICE-A-FIXTURE"});await origin.session.initialize();
    const other=fixture(origin.disk());expect((await other.session.initialize()).state).toBe("reference-unavailable");
    expect(other.settings.apiKey).toBe("");await other.session.save();
    expect(other.disk().credentialRefs).toEqual(origin.disk().credentialRefs);
  });
  it("survives a legacy-shaped settings round trip without reintroducing plaintext",async()=>{
    const f=fixture({apiKey:"ROLLBACK-FIXTURE"});await f.session.initialize();
    const oldVersion=migrateSettings(f.disk());expect(oldVersion.apiKey).toBe("");
    oldVersion.learningFlowEnabled=false;oldVersion.webEnabled=false;
    const reopenedSettings=migrateSettings(JSON.parse(JSON.stringify(oldVersion)));
    const reopened=new CredentialSettingsSession(reopenedSettings,f.store,{write:f.write});
    await reopened.initialize();expect(reopenedSettings.apiKey).toBe("ROLLBACK-FIXTURE");
    expect(reopenedSettings.webEnabled).toBe(false);expect(JSON.stringify(reopenedSettings)).not.toContain("ROLLBACK-FIXTURE");
  });
  it("migrates a restored old plaintext configuration into a new reference without changing providers",async()=>{
    const f=fixture({apiBaseUrl:"https://restored.test/v1",apiKey:"RESTORED-FIXTURE"});
    await f.session.initialize();expect(f.settings.apiBaseUrl).toBe("https://restored.test/v1");expect(f.disk().apiKey).toBeUndefined();
    expect(f.settings.credentialRefs[0]?.binding).toBe(credentialBinding(f.settings,"apiKey"));
  });
  it("serializes overlapping saves without losing a newer key entered during encryption",async()=>{
    const f=fixture();await f.session.initialize();
    let release!:()=>void;const pending=new Promise<void>(resolve=>{release=resolve;});
    const put=vi.mocked(f.store.put).getMockImplementation()!;let entered!:()=>void;const ready=new Promise<void>(resolve=>{entered=resolve;});
    vi.mocked(f.store.put).mockImplementationOnce(async(...args)=>{entered();await pending;return put(...args);});
    f.settings.apiKey="FIRST-FIXTURE";const first=f.session.save();await ready;
    f.settings.apiKey="SECOND-FIXTURE";const second=f.session.save();release();await Promise.all([first,second]);
    const ref=f.settings.credentialRefs.find(ref=>ref.slot==="apiKey")!;
    expect(await f.store.get(ref)).toBe("SECOND-FIXTURE");expect(f.settings.apiKey).toBe("SECOND-FIXTURE");
  });
  it("explicitly clears an inaccessible reference without needing encryption",async()=>{
    const origin=fixture({apiKey:"CLEAR-FIXTURE"});await origin.session.initialize();
    const f=fixture(origin.disk(),false);await f.session.initialize();f.settings.apiKey="";await f.session.save();
    expect(f.disk().credentialRefs).toEqual([]);
  });
  it("drops session-only secrets when disposed and rejects later persistence",async()=>{
    const f=fixture({},false);await f.session.initialize();f.settings.apiKey="DISPOSE-FIXTURE";await f.session.save();
    f.session.dispose();expect(f.settings.apiKey).toBe("");expect(credentialStatusFor(f.settings)).toBeUndefined();
    await expect(f.session.save()).rejects.toThrow("credential-session-closed");
    expect(JSON.stringify(f.disk())).not.toContain("DISPOSE-FIXTURE");
  });
});

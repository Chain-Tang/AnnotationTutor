import {it,expect,vi} from "vitest";
import {resolveCodexCommand} from "../src/codex-command.js";
const deps=()=>({platform:"darwin" as const,home:"/Users/test",probe:vi.fn(async()=>null),executable:vi.fn(async(path:string)=>path==="/Applications/ChatGPT.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex")});
it("finds the installed bundled CLI when the GUI and login shell lack it",async()=>{const env={PATH:"/usr/bin:/bin"};const result=await resolveCodexCommand("codex",env,deps());expect(result.command).toContain("CodexCLI.app");expect(env.PATH).toBe("/usr/bin:/bin");});
it("keeps an explicit configured command authoritative",async()=>{const d=deps();expect((await resolveCodexCommand("/custom/codex",{},d)).command).toBe("/custom/codex");expect(d.probe).not.toHaveBeenCalled();});
it("reports missing installation instead of generic disconnect",async()=>{const d=deps();d.executable.mockResolvedValue(false);await expect(resolveCodexCommand("codex",{},d)).rejects.toThrow("codex-command-not-found");});
it("uses Windows path semantics when resolving a Windows host",async()=>{
  const d={...deps(),platform:"win32" as const,home:"C:\\Users\\test"};
  d.executable.mockImplementation(async path=>path==="C:\\Tools\\codex");
  expect((await resolveCodexCommand("codex",{PATH:"C:\\Tools;C:\\Windows"},d)).command).toBe("C:\\Tools\\codex");
});

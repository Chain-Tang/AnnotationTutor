import { access, constants } from "node:fs/promises";
import { homedir } from "node:os";
import { posix, win32 } from "node:path";
import { openCodeSpawnEnv, probeOpenCodeEnv } from "./opencode-setup.js";

/** GUI apps may have only the system PATH. Never change the user's global environment. */
export async function resolveCodexCommand(command:string, env:NodeJS.ProcessEnv=process.env, deps={
  probe:probeOpenCodeEnv,
  executable:async(path:string)=>{try{await access(path,constants.X_OK);return true;}catch{return false;}},
  platform:process.platform, home:homedir()
}):Promise<{command:string;env:NodeJS.ProcessEnv}>{
  if(command!=="codex")return {command,env}; // An explicitly configured command always wins.
  const {join}=deps.platform==="win32"?win32:posix;
  const probe=await deps.probe({binName:"codex",env,timeoutMs:5000});
  const merged=probe?.path?openCodeSpawnEnv(probe.path,env,deps.platform):env;
  if(probe?.opencode && await deps.executable(probe.opencode))return {command:probe.opencode,env:merged};
  const candidates=[...(merged.PATH??merged.Path??"").split(deps.platform==="win32"?";":":").filter(Boolean).map(p=>join(p,"codex")),
    join(deps.home,".local/bin/codex"),"/opt/homebrew/bin/codex","/usr/local/bin/codex"];
  if(deps.platform==="darwin")for(const apps of ["/Applications",join(deps.home,"Applications")])candidates.push(
    join(apps,"Codex.app/Contents/Resources/codex"),
    join(apps,"ChatGPT.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex"));
  for(const path of candidates)if(await deps.executable(path))return {command:path,env:merged};
  // Windows spawn performs PATHEXT resolution; its error is preserved by the adapter.
  if(deps.platform==="win32")return {command,env:merged};
  throw new Error("codex-command-not-found: Configure the installed Codex executable in Tutor settings.");
}

import {collectLicenses} from "./collect-licenses.mjs";
import { build } from 'esbuild';
import { readFile, writeFile, mkdir, cp } from 'node:fs/promises';
import { resolve } from 'node:path';
const root=resolve(import.meta.dirname,'..'),dir=resolve(root,'host-plugins/tutor');
const source=JSON.parse(await readFile(resolve(dir,'plugin.json'),'utf8'));
const compat={name:source.name,version:source.version,description:source.description,author:source.author,license:source.license,skills:'./skills/',mcpServers:'./.mcp.json',interface:{displayName:'Tutor',shortDescription:'Learning and precise drawing with your Obsidian Tutor.',longDescription:'Connect to an independently reasoning Tutor with scoped access, editable drawing transactions and cancellable tasks.',developerName:source.author.name,category:'Productivity',capabilities:['Interactive','Write'],defaultPrompt:['请教 Tutor：结合我的学习材料解释这个问题。','请 Tutor 在授权画板上画一个示意图。','交给 Tutor 独立检查这段解释。']}};
await mkdir(resolve(dir,'.codex-plugin'),{recursive:true});
await writeFile(resolve(dir,'.codex-plugin/plugin.json'),JSON.stringify(compat,null,2)+'\n');
const mcp={mcpServers:{tutor:{command:'node',args:['${PLUGIN_ROOT}/scripts/connector.cjs']}}};
await writeFile(resolve(dir,'.mcp.json'),JSON.stringify(mcp,null,2)+'\n');
await writeFile(resolve(dir,'mcp.json'),JSON.stringify({$schema:'https://agent-plugins.org/schemas/1.0.0/mcp.schema.json',mcpServers:{tutor:{type:'stdio',...mcp.mcpServers.tutor}}},null,2)+'\n');
const result=await build({metafile:true,entryPoints:[resolve(dir,'scripts/connector-source.mjs')],outfile:resolve(dir,'scripts/connector.cjs'),platform:'node',target:'node22',format:'cjs',bundle:true,minify:false,logLevel:'info'});
await cp(resolve(root,'LICENSE'),resolve(dir,'LICENSE'));

await collectLicenses([result.metafile],resolve(dir,"licenses"));

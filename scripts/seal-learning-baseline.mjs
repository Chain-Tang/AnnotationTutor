import {execFileSync} from 'node:child_process';
import {readFile,mkdir,writeFile,cp,chmod} from 'node:fs/promises';
import {join} from 'node:path';import {homedir} from 'node:os';import {createHash} from 'node:crypto';import {zipSync} from 'fflate';
const root=process.cwd(),version=JSON.parse(await readFile('manifest.json','utf8')).version;
const dest=join(homedir(),'Library/Application Support/Tutor/backups',`natural-learning-${version}-${Date.now()}`);await mkdir(dest,{recursive:true,mode:0o700});
const entries={};for(const rel of new Set(execFileSync('git',['ls-files','-c','-o','--exclude-standard','-z'],{encoding:'utf8'}).split('\0').filter(Boolean))){try{entries[rel]=new Uint8Array(await readFile(join(root,rel)));}catch(e){if(!['ENOENT','EISDIR'].includes(e.code))throw e;}}
const bytes=zipSync(entries,{level:6});await writeFile(join(dest,'source.zip'),bytes,{mode:0o600});
for(const [label,vault]of [['current','/Users/mac/Documents'],['test','/Users/mac/Tutor-Acceptance']]){const installed=join(vault,'.obsidian/plugins/annotation-tutor-lite');await cp(installed,join(dest,label),{recursive:true});await chmod(join(dest,label,'data.json'),0o600);}
const report={version,files:Object.keys(entries).length,sha256:createHash('sha256').update(bytes).digest('hex'),backup:dest};await writeFile(join(dest,'manifest.json'),JSON.stringify(report),{mode:0o600});console.log(JSON.stringify(report));

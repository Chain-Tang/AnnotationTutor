import {readFile,writeFile,mkdir,readdir,stat,cp,rm} from 'node:fs/promises';
import {join,resolve} from 'node:path';import {createHash} from 'node:crypto';import {zipSync} from 'fflate';
await import('./package.mjs');await import('./build-tutor-plugin.mjs');
const root=resolve(import.meta.dirname,'..'),dist=join(root,'dist');
await cp(join(root,'LICENSE'),join(root,'android-companion/LICENSE'));
async function archive(directory,filename,prefix){const entries={};for(const rel of await readdir(directory,{recursive:true})){const path=join(directory,rel);if(!(await stat(path)).isFile()||rel.split('/').some(s=>['.gradle','build','.DS_Store','local.properties'].includes(s)))continue;entries[`${prefix}/${rel}`]=new Uint8Array(await readFile(path));}await writeFile(join(dist,filename),zipSync(entries,{level:6,mtime:new Date('1980-01-01T00:00:00Z')}));return {file:filename,files:Object.keys(entries).length};}
const version=JSON.parse(await readFile(join(root,'manifest.json'),'utf8')).version;
const recovery=join(dist,'recovery');await rm(recovery,{recursive:true,force:true});await mkdir(join(recovery,'scripts'),{recursive:true});
for(const file of ['install-dev-plugin.mjs','release-transaction.mjs','release-state.mjs','recover-private-state.mjs','obsidian-eval.mjs'])await cp(join(root,'scripts',file),join(recovery,'scripts',file));
await cp(join(root,'docs/private-storage-recovery.md'),join(recovery,'README.md'));
const packages=[await archive(recovery,`tutor-recovery-${version}.zip`,'tutor-recovery'),{file:`annotation-tutor-lite-${version}.zip`},await archive(join(root,'host-plugins/tutor'),`tutor-codex-${version}.zip`,'tutor'),await archive(join(root,'android-companion'),'tutor-ink-android-source-0.1.0.zip','tutor-ink')];
for(const pkg of packages){const bytes=await readFile(join(dist,pkg.file));Object.assign(pkg,{bytes:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex')});}
await writeFile(join(dist,'upgrade-packages.json'),JSON.stringify({version,channel:'desktop-preview',builtAt:new Date().toISOString(),androidApk:false,packages},null,2)+'\n');console.log(JSON.stringify(packages));

const archiveDir=join(dist,'milestones',`${version}-${Date.now()}`);await mkdir(archiveDir,{recursive:true});for(const pkg of packages)await cp(join(dist,pkg.file),join(archiveDir,pkg.file));await cp(join(dist,'upgrade-packages.json'),join(archiveDir,'upgrade-packages.json'));console.log('Archived milestone:',archiveDir);

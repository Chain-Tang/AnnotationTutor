import {readFile,readdir,mkdir,writeFile,stat,rm} from 'node:fs/promises';import {resolve,dirname,basename,join} from 'node:path';
/** Preserve upstream notices for every bundled npm package, following esbuild's input graph. */
export async function collectLicenses(metafiles,destination,{absWorkingDir=process.cwd()}={}){
 const roots=new Set();for(const meta of metafiles)for(const file of Object.keys(meta.inputs)){if(!file.includes('node_modules/'))continue;let dir=dirname(resolve(absWorkingDir,file)),found=false;while(dir.includes('node_modules')){try{const pkg=JSON.parse(await readFile(join(dir,'package.json'),'utf8'));if(pkg.name&&pkg.version){roots.add(dir);found=true;break;}}catch{}dir=dirname(dir);}if(!found)throw new Error(`Cannot locate bundled dependency package: ${file}`);}
 await rm(destination,{recursive:true,force:true});await mkdir(destination,{recursive:true});const notices=[];
 for(const dir of [...roots].sort()){const pkg=JSON.parse(await readFile(join(dir,'package.json'),'utf8'));const name=`${pkg.name}@${pkg.version}`;const files=(await readdir(dir)).filter(file=>/^(license|copying|notice)(\.|$)/i.test(file));const target=name.replace(/[^a-zA-Z0-9_.-]/g,'_');await mkdir(join(destination,target),{recursive:true});
 for(const file of files)await writeFile(join(destination,target,file),await readFile(join(dir,file)));
 if(!files.length){await writeFile(join(destination,target,'NOTICE.txt'),`${name}\nLicense: ${JSON.stringify(pkg.license)}\nRepository: ${JSON.stringify(pkg.repository)}\n`);files.push('NOTICE.txt');}
 notices.push({name:pkg.name,version:pkg.version,license:pkg.license??'See upstream package',repository:pkg.repository,files:files.map(file=>`${target}/${file}`)});
 }
 await writeFile(join(destination,'dependencies.json'),JSON.stringify(notices,null,2)+'\n');
}

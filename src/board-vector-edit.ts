import {z} from 'zod';
import {boardVectorNodeSchema,boardVectorAssetSchema} from './board-model.js';
import type {BoardDocument,BoardVectorNode} from './board-types.js';

export const vectorPatchSchema=z.object(boardVectorNodeSchema.shape).pick({name:true,semanticRole:true,transform:true,opacity:true,blendMode:true,visible:true,locked:true,fill:true,stroke:true,path:true,text:true}).partial().strict();
export const vectorEditSchema=z.object({type:z.literal('vector-edit'),objectId:z.string().min(1),expectedRevision:z.number().int().nonnegative(),nodes:z.array(z.object({id:z.string().min(1),patch:vectorPatchSchema}).strict()).min(1).max(128)}).strict();
export type VectorEdit=z.infer<typeof vectorEditSchema>;
export function assertVectorUnlocked(nodes:readonly BoardVectorNode[],id:string):void{
  const map=new Map(nodes.map(n=>[n.id,n]));let node=map.get(id);if(!node)throw new Error('unknown-vector-node');const seen=new Set<string>();
  while(node){if(node.locked||seen.has(node.id))throw new Error('vector-node-locked');seen.add(node.id);node=node.parentId?map.get(node.parentId):undefined;}
}
/** Copy-on-write preserves every prior character version and other instances. */
export function applyVectorEdit(document:BoardDocument,input:VectorEdit,actor:'human'|'tutor'='tutor'):void{
  const edit=vectorEditSchema.parse(input),object=document.objects.find(o=>o.id===edit.objectId);
  if(!object||object.kind!=='vector'||object.revision!==edit.expectedRevision)throw new Error('object-revision-conflict');
  let layer=document.layers?.find(l=>l.id===object.layerId);const seen=new Set<string>();
  while(layer){if(layer.locked||seen.has(layer.id))throw new Error('layer-locked');seen.add(layer.id);layer=document.layers?.find(l=>l.id===layer!.parentId);}
  const source=document.vectorAssets?.find(a=>a.id===object.vectorAssetId&&a.version===object.vectorAssetVersion);if(!source)throw new Error('missing-vector-asset');
  if(new Set(edit.nodes.map(n=>n.id)).size!==edit.nodes.length)throw new Error('duplicate-node-edit');
  const asset=structuredClone(source);
  for(const {id,patch} of edit.nodes){
    const node=asset.nodes.find(n=>n.id===id);if(!node)throw new Error('unknown-vector-node');
    // Only a human inspector may explicitly unlock the selected node; locked ancestors still protect it.
    const unlock=actor==='human'&&node.locked&&Object.keys(patch).length===1&&patch.locked===false;
    assertVectorUnlocked(unlock?asset.nodes.map(n=>n.id===id?{...n,locked:false}:n):asset.nodes,id);
    if(patch.path&&node.kind!=='path'||patch.text&&node.kind!=='text')throw new Error('vector-payload-kind-mismatch');
    Object.assign(node,boardVectorNodeSchema.parse({...node,...patch}));
  }
  asset.version=Math.max(...document.vectorAssets!.filter(a=>a.id===source.id).map(a=>a.version))+1;asset.createdAt=new Date().toISOString();delete asset.geometryHash;
  document.vectorAssets!.push(boardVectorAssetSchema.parse(asset));object.vectorAssetVersion=asset.version;object.revision++;object.editedBy=actor;
}

import type { BoardObject } from "./board-types.js";
import type { BoardSurfaceOperation, TutorBoardSurface } from "./tutor-board-surface.js";
import type { ChangeSet, SurfaceScene } from "./tutor-surface.js";
import type { ContextGrant } from "./tutor-task.js";

/** Local compiler output can contain many sampled math paths; public tools retain their small operation limit. */
export async function commitStudioConversationDrawing(
  surface:TutorBoardSurface, scene:SurfaceScene, change:ChangeSet<BoardSurfaceOperation>, layerId:string,
  grant:ContextGrant, signal:AbortSignal,
) {
  if (change.targetId!==scene.target.id || change.baseRevision!==scene.target.revision) throw new Error("scene-revision-conflict");
  const operations=structuredClone(change.operations);
  for(const operation of operations)if(operation.type==="add")operation.object.layerId=layerId;
  if(operations.some(operation=>operation.type==="vector-edit"))return surface.commit({...change,operations},grant,signal);
  const before=structuredClone(scene.objects) as BoardObject[], byId=new Map(before.map(object=>[object.id,object]));
  const touched=new Set<string>();
  for(const operation of operations){
    if(operation.type==="vector-edit")throw new Error("mixed-vector-drawing");
    const id=operation.type==="add"?operation.object.id:operation.objectId;
    if(touched.has(id))throw new Error("duplicate-object-operation");
    touched.add(id);
    const previous=byId.get(id);
    if(operation.type==="add"){
      if(previous)throw new Error("duplicate-object-id");
      byId.set(id,{...operation.object,groupId:change.id});
    }else{
      if(!previous || previous.revision!==operation.expectedRevision)throw new Error("object-revision-conflict");
      if(operation.type==="remove")byId.delete(id);
      else {
        if(operation.object.id!==id)throw new Error("object-identity-or-anchor-change");
        byId.set(id,{...operation.object,groupId:previous.groupId.startsWith("LAYOUT-")?previous.groupId:change.id});
      }
    }
  }
  return surface.commitPreparedDrawing({...change,before,after:[...byId.values()]},grant,signal);
}

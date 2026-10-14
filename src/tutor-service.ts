import {planVectorEdit} from "./board-vector-agent.js";
import type { AnnotationTutorLiteSettings } from "./settings-config.js";
import type { TutorMcpHost } from "./tutor-mcp.js";
import { resolveBoardConnection } from "./board-connection.js";
import { resolveTutorAction, type TutorAction } from "./tutor-intent.js";
import { DirectTutorAdapter, AcpTutorAdapter } from "./tutor-agent-adapters.js";
import { createBoardAgent, requestBoardWithRepair } from "./board-agent.js";
import { planExcalidraw } from "./excalidraw-agent.js";
import { nodeHttpStream } from "./api-stream.js";
import type { BoardObject } from "./board-types.js";
import type { TutorTaskCoordinator } from "./tutor-task.js";
import { tmpdir } from "node:os";

/** Independent Tutor reasoning; it never adopts a sidebar session or commits a draft. */
export function tutorServiceRunner(settings:()=>AnnotationTutorLiteSettings,tasks:TutorTaskCoordinator,env:()=>NodeJS.ProcessEnv,classified?:TutorAction):TutorMcpHost["run"] {
  return async input=>{
    const config=settings(),route=resolveBoardConnection(config),client=input.task.clientId,task=input.task.id;
    const transport={...route,baseUrl:config.apiBaseUrl,apiKey:config.apiKey,command:config.agentCommand,cwd:tmpdir(),env:env(),httpStream:nodeHttpStream};
    if(!classified){tasks.phase(task,client,"classifying",route);tasks.consume(task,client,"modelCalls");}
    const action=classified??await resolveTutorAction(input.prompt,[],{...transport,signal:input.signal});
    tasks.phase(task,client,action.intent==="draw"?"drafting":"reasoning",route);
    if(action.intent==="draw"){
      if(!input.surface)throw new Error("drawing-target-required");
      const scene=await input.surface.read();
      if(scene.target.revision!==input.task.target?.revision)throw new Error("scene-revision-conflict");
      tasks.consume(task,client,"modelCalls");
      let operations:unknown[];
      if(action.drawing.mode==="native"&&scene.vectorAssets?.length&&scene.objects.some(o=>scene.selection.includes((o as BoardObject).id)&&(o as BoardObject).kind==="vector")){
        operations=(await planVectorEdit({scene,instruction:input.prompt,signal:input.signal,connection:transport,task:input.task})).operations;
      }else if(scene.target.surface==="excalidraw"){
        const result=await planExcalidraw({...transport,scene,instruction:input.prompt,signal:input.signal});
        operations=result.operations;
      }else{
        if(action.drawing.mode==="reference")throw new Error("reference-generation-requires-Studio-candidate-workflow");
        if(!input.surface.capture)throw new Error("visual-capture-unavailable");
        const snapshot=await input.surface.capture();
        if((await input.surface.read()).target.revision!==scene.target.revision)throw new Error("scene-revision-conflict");
        const agent=createBoardAgent(transport),cancel=()=>agent.cancel();input.signal.addEventListener("abort",cancel,{once:true});
        try{
          const result=await requestBoardWithRepair(agent,{boardId:scene.target.id,sessionId:task,requestId:crypto.randomUUID(),baseRevision:parseInt(scene.target.revision,10),sourceRevision:snapshot.layoutRevision,sourceFile:scene.target.source,anchor:snapshot.anchor,snapshot,objects:scene.objects as BoardObject[],instruction:input.prompt,context:input.context,character:null,math:action.drawing.mode==="math",requiresDrawing:true},event=>{
            if(event.type==="reply")input.emit(event.text);
          },()=>!input.signal.aborted);
          if(!result.ok)throw new Error(result.error);operations=result.operations;
        }finally{input.signal.removeEventListener("abort",cancel);agent.dispose();}
      }
      if(input.signal.aborted)throw new Error("task-cancelled");
      const id=crypto.randomUUID();return [{id,type:"changes",data:{id,taskId:task,targetId:scene.target.id,baseRevision:scene.target.revision,operations,dependencies:[]}}];
    }
    tasks.consume(task,client,"modelCalls");
    const adapter=route.engine==="api"?new DirectTutorAdapter(transport):new AcpTutorAdapter(transport);
    try{return await adapter.run({...input,emit:event=>{if(event.type==="text")input.emit((event.data as {text:string}).text);}});}finally{adapter.dispose();}
  };
}

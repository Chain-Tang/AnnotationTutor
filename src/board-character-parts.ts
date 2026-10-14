import type {BoardVectorAsset,BoardVectorNode,BoardCharacterDefinition,BoardCharacterRecipe} from './board-types.js';
export function builtInPartCharacter(style:'round'|'book'):{asset:BoardVectorAsset;definition:BoardCharacterDefinition}{
  const common={transform:[1,0,0,1,0,0] as [number,number,number,number,number,number],opacity:1,blendMode:'normal' as const,visible:true,locked:false};
  const stroke={paint:{kind:'solid' as const,color:'#544567',opacity:1},width:3,lineCap:'round' as const,lineJoin:'round' as const};
  const shape=(id:string,shape:BoardVectorNode['shape'],color:string):BoardVectorNode=>({...common,id,name:id,semanticRole:id,kind:'shape',shape,fill:{kind:'solid',color,opacity:1},stroke});
  const nodes:BoardVectorNode[]=[
    shape('body',style==='round'?{kind:'ellipse',cx:100,cy:102,rx:72,ry:76}:{kind:'rect',x:30,y:30,width:140,height:144,rx:14},'#fff2d6'),
    shape('clothes',{kind:'rect',x:54,y:126,width:92,height:34,rx:12},'#8d7dc4'),
    shape('eye-left',{kind:'ellipse',cx:76,cy:82,rx:5,ry:9},'#544567'),
    shape('eye-right',{kind:'ellipse',cx:124,cy:82,rx:5,ry:9},'#544567'),
    {...common,id:'mouth',name:'mouth',semanticRole:'mouth',kind:'path',path:[{op:'M',x:84,y:105},{op:'Q',x1:100,y1:121,x:116,y:105}],fill:{kind:'none'},stroke},
    {...common,id:'arm-left',name:'arm-left',semanticRole:'arm',kind:'path',transform:[1,0,0,1,40,110],path:[{op:'M',x:0,y:0},{op:'Q',x1:-20,y1:0,x:-26,y:18}],stroke,fill:{kind:'none'}},
    {...common,id:'arm-right',name:'arm-right',semanticRole:'arm',kind:'path',transform:[1,0,0,1,160,110],path:[{op:'M',x:0,y:0},{op:'Q',x1:20,y1:0,x:26,y:18}],stroke,fill:{kind:'none'}},
  ];
  if(style==='book')nodes.push({...common,id:'page-fold',name:'page-fold',kind:'path',path:[{op:'M',x:100,y:35},{op:'L',x:100,y:69}],stroke,fill:{kind:'none'}});
  const asset:BoardVectorAsset={format:'board-vector-v1',id:`tutor-parts-${style}`,version:1,name:style,width:200,height:200,rootIds:nodes.map(n=>n.id),nodes,createdAt:'2026-09-20T00:00:00.000Z'};
  const definition:BoardCharacterDefinition={format:'board-character-v1',id:`${asset.id}-definition`,version:1,name:style,vectorAssetId:asset.id,vectorAssetVersion:1,rig:{joints:[]},parts:nodes.filter(n=>n.semanticRole).map((n,i)=>({id:n.id,name:n.name,slot:n.semanticRole!,rootNodeId:n.id,layer:i})),faceControls:[],presets:[{id:'neutral',kind:'pose',values:{}},{id:'wave',kind:'gesture',values:{'node.arm-right.rotate':-1.4}},{id:'blink',kind:'gesture',values:{'node.eye-left.opacity':.08,'node.eye-right.opacity':.08}}],rules:{exclusiveSlots:[],handOccupancy:[],layerOrder:[]},createdAt:asset.createdAt};
  return {asset,definition};
}
export function partRecipe(definition:BoardCharacterDefinition,preset:string):BoardCharacterRecipe{return {definitionId:definition.id,definitionVersion:definition.version,pose:'neutral',gestures:preset==='neutral'?[]:[preset],expression:{emotion:{},mouth:{},blink:{},gaze:{},micro:{}},props:[]};}

/** Complete static reference character used by the Studio and character-tool acceptance tests. */
export function builtInReferenceCharacter():{asset:BoardVectorAsset;definition:BoardCharacterDefinition;recipe:BoardCharacterRecipe}{
  const common={transform:[1,0,0,1,0,0] as [number,number,number,number,number,number],opacity:1,blendMode:'normal' as const,visible:true,locked:false};
  const shape=(id:string,parentId:string,geometry:NonNullable<BoardVectorNode['shape']>,color:string,visible=true):BoardVectorNode=>({...common,id,parentId,name:id,semanticRole:id,kind:'shape',visible,shape:geometry,fill:{kind:'solid',color,opacity:1}});
  const nodes:BoardVectorNode[]=[
    {...common,id:'character-root',name:'Reference character',kind:'group'},
    shape('back-hair','character-root',{kind:'ellipse',cx:128,cy:76,rx:58,ry:66},'#403449'),
    shape('body','character-root',{kind:'rect',x:91,y:121,width:74,height:94,rx:28},'#f1c7ae'),
    shape('face','character-root',{kind:'ellipse',cx:128,cy:76,rx:45,ry:50},'#f6d4bd'),
    shape('eye-left','character-root',{kind:'ellipse',cx:110,cy:73,rx:4,ry:7},'#302b35'),
    shape('eye-right','character-root',{kind:'ellipse',cx:146,cy:73,rx:4,ry:7},'#302b35'),
    shape('blink','character-root',{kind:'rect',x:102,y:72,width:52,height:3,rx:1.5},'#302b35',false),
    shape('mouth-smile','character-root',{kind:'ellipse',cx:128,cy:96,rx:10,ry:5},'#b85f68'),
    {...common,id:'front-hair',parentId:'character-root',name:'front-hair',semanticRole:'front-hair',kind:'path',path:[{op:'M',x:84,y:58},{op:'Q',x1:128,y1:10,x:172,y:58},{op:'Q',x1:150,y1:45,x:128,y:62},{op:'Q',x1:108,y1:43,x:84,y:58},{op:'Z'}],fill:{kind:'solid',color:'#403449',opacity:1}},
    shape('casual-top','character-root',{kind:'rect',x:83,y:121,width:90,height:65,rx:18},'#7663bd'),
    shape('uniform-top','character-root',{kind:'rect',x:83,y:121,width:90,height:65,rx:8},'#314b6b',false),
    shape('hand-left','character-root',{kind:'ellipse',cx:72,cy:160,rx:12,ry:18},'#f6d4bd'),
    shape('hand-right','character-root',{kind:'ellipse',cx:184,cy:160,rx:12,ry:18},'#f6d4bd'),
    shape('prop-book','character-root',{kind:'rect',x:49,y:137,width:31,height:43,rx:3},'#d99052',false),
    shape('prop-cup','character-root',{kind:'rect',x:177,y:139,width:25,height:31,rx:5},'#81a9c8',false),
  ];
  const asset:BoardVectorAsset={format:'board-vector-v1',id:'tutor-reference-character',version:1,name:'Tutor reference character',width:256,height:240,rootIds:['character-root'],nodes,createdAt:'2026-09-23T00:00:00.000Z'};
  const definition:BoardCharacterDefinition={format:'board-character-v1',id:'tutor-reference-character-definition',version:1,name:'Tutor reference character',vectorAssetId:asset.id,vectorAssetVersion:1,rig:{joints:[
    {id:'head',name:'Head',x:128,y:76,minAngle:-.6,maxAngle:.6},{id:'neck',name:'Neck',parentId:'head',x:128,y:119,minAngle:-.3,maxAngle:.3},
    {id:'shoulder-left',name:'Left shoulder',parentId:'neck',x:92,y:133},{id:'elbow-left',name:'Left elbow',parentId:'shoulder-left',x:75,y:151},{id:'wrist-left',name:'Left wrist',parentId:'elbow-left',x:70,y:169},
    {id:'shoulder-right',name:'Right shoulder',parentId:'neck',x:164,y:133},{id:'elbow-right',name:'Right elbow',parentId:'shoulder-right',x:181,y:151},{id:'wrist-right',name:'Right wrist',parentId:'elbow-right',x:186,y:169},
    {id:'hip-left',name:'Left hip',parentId:'neck',x:108,y:205},{id:'knee-left',name:'Left knee',parentId:'hip-left',x:108,y:222},{id:'ankle-left',name:'Left ankle',parentId:'knee-left',x:108,y:236},
    {id:'hip-right',name:'Right hip',parentId:'neck',x:148,y:205},{id:'knee-right',name:'Right knee',parentId:'hip-right',x:148,y:222},{id:'ankle-right',name:'Right ankle',parentId:'knee-right',x:148,y:236},
  ]},parts:[
    {id:'casual-top',name:'Casual top',slot:'top',rootNodeId:'casual-top',layer:7,exclusive:true},{id:'uniform-top',name:'Uniform top',slot:'top',rootNodeId:'uniform-top',layer:7,exclusive:true},
    {id:'front-hair',name:'Front hair',slot:'hair-front',rootNodeId:'front-hair',layer:10},{id:'back-hair',name:'Back hair',slot:'hair-back',rootNodeId:'back-hair',layer:0},
  ],faceControls:[
    {id:'happy',channel:'emotion',nodeIds:['mouth-smile'],min:0,max:1},{id:'open-mouth',channel:'mouth',nodeIds:['mouth-smile'],min:0,max:1},{id:'blink-both',channel:'blink',nodeIds:['blink'],min:0,max:1},{id:'look-side',channel:'gaze',nodeIds:['eye-left','eye-right'],min:0,max:1},{id:'blush',channel:'micro',nodeIds:['face'],min:0,max:1},
  ],presets:[
    {id:'neutral',kind:'pose',values:{}},{id:'wave-left',kind:'gesture',values:{'node.hand-left.translateY':-35,'node.hand-left.rotate':-.5}},{id:'wave-right',kind:'gesture',values:{'node.hand-right.translateY':-35,'node.hand-right.rotate':.5}},
    {id:'casual',kind:'outfit',values:{'casual-top':true}},{id:'uniform',kind:'outfit',values:{'uniform-top':true}},
    {id:'book',kind:'prop',values:{'node.prop-book.visible':true}},{id:'cup',kind:'prop',values:{'node.prop-cup.visible':true}},
  ],rules:{exclusiveSlots:['top'],handOccupancy:[{presetId:'book',hands:['left']},{presetId:'cup',hands:['right']}],layerOrder:['back-hair','body','top','face','front-hair','props']},createdAt:asset.createdAt};
  const recipe:BoardCharacterRecipe={definitionId:definition.id,definitionVersion:1,pose:'neutral',gestures:[],expression:{emotion:{happy:1},mouth:{},blink:{},gaze:{},micro:{}},outfit:'casual',props:[]};
  return {asset,definition,recipe};
}

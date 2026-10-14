// @vitest-environment happy-dom
import {it,expect} from 'vitest';
import {pdfLearningContext} from '../src/learning-pdf-context.js';
it('binds a scan with no text to its PDF and does not claim image observation',()=>{
 const el=document.createElement('div');const ctx=pdfLearningContext(el,{path:'scan.pdf',basename:'scan',stat:{mtime:1,size:5}});
 expect(ctx).toMatchObject({notePath:'scan.pdf',content:'',observation:{scope:'unavailable',hasImage:false,version:'1:5'}});
});
it('takes only visible pages from this PDF view, not another split or hidden page',()=>{
 const el=document.createElement('div');el.innerHTML='<div class="page"><div class="textLayer"><span>local text</span></div></div><div class="page"><div class="textLayer"><span>hidden</span></div></div>';
 el.getBoundingClientRect=()=>({top:0,bottom:500} as DOMRect);
 el.children[0]!.getBoundingClientRect=()=>({top:10,bottom:200,width:100,height:190} as DOMRect);el.children[1]!.getBoundingClientRect=()=>({top:600,bottom:900,width:100,height:300} as DOMRect);
 expect(pdfLearningContext(el,{path:'text.pdf',basename:'text',stat:{mtime:1,size:5}})).toMatchObject({content:'local text',observation:{scope:'visible-text',hasImage:false}});
});

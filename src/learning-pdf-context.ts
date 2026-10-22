import {selectionFromPdfView} from './pdf-annotation.js';
import type {ObservationContext} from './teaching-policy.js';
/** Read only this view's exposed text layer; a scan without text is explicitly unavailable. */
export function pdfLearningContext(container:HTMLElement,file:{path:string;basename:string;stat:{mtime:number;size:number}}){
 const selection=selectionFromPdfView(container,container.ownerDocument.getSelection())?.text??'';
 const bounds=container.getBoundingClientRect();
 const visibleText=[...container.querySelectorAll<HTMLElement>('.page')].filter(page=>{const rect=page.getBoundingClientRect();return rect.width>0&&rect.height>0&&rect.bottom>bounds.top&&rect.top<bounds.bottom;})
  .map(page=>[...page.querySelectorAll<HTMLElement>('.textLayer span')].map(span=>span.textContent??'').join(' ')).join('\n').slice(0,12000);
 const observation:ObservationContext={source:file.path,version:`${file.stat.mtime}:${file.stat.size}`,scope:selection?'selection':visibleText?'visible-text':'unavailable',hasImage:false};
 return {notePath:file.path,noteTitle:file.basename,selection,visibleText,content:selection||visibleText,observation};
}

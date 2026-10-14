import {it,expect} from 'vitest';
import {selectedStudyContext,drawingSource,selectionDrawingInstruction} from '../src/selection-context.js';
it('binds the explicit selection to its source instead of another active document',()=>{
  const context=selectedStudyContext('A.md','A','limit','document');
  expect(drawingSource(context,'B.md')).toBe('A.md');
  expect(drawingSource({notePath:'A.md'},'B.md')).toBe('B.md');
  expect(context.observation).toMatchObject({source:'A.md',scope:'selection',hasImage:false});
  expect(selectionDrawingInstruction('draw a diagram',context)).toContain('"limit"');
});
it('bounds quoted selection text and keeps ordinary chat unchanged',()=>{
  expect(selectionDrawingInstruction('explain',{selection:'text'})).toBe('explain');
  const context=selectedStudyContext('A.md','A','x'.repeat(20000));
  expect(selectionDrawingInstruction('draw',context).length).toBeLessThan(6200);
});

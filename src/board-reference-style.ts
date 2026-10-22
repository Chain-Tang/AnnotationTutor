import { z } from 'zod';

export const referencePaintStyleSchema = z.object({
  outlineBrush: z.enum(['pen', 'fountain', 'pencil', 'marker', 'highlighter', 'chalk', 'crayon', 'watercolor', 'sumi', 'oil']),
  colorMode: z.enum(['solid', 'brush']),
  colorBrush: z.enum(['pen', 'fountain', 'pencil', 'marker', 'highlighter', 'chalk', 'crayon', 'watercolor', 'sumi', 'oil']),
}).strict();
export type ReferencePaintStyle = z.infer<typeof referencePaintStyleSchema>;
export const referencePaintPresets = {
  illustration: { outlineBrush: 'pen', colorMode: 'solid', colorBrush: 'marker' },
  oil: { outlineBrush: 'pencil', colorMode: 'brush', colorBrush: 'oil' },
  crayon: { outlineBrush: 'pencil', colorMode: 'brush', colorBrush: 'crayon' },
  watercolor: { outlineBrush: 'pencil', colorMode: 'brush', colorBrush: 'watercolor' },
} as const satisfies Record<string, ReferencePaintStyle>;

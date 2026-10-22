import {z} from 'zod';
import { communicationIdentitySchema } from './tutor-communication.js';
const id=z.string().min(1).max(200);
const path=z.string().min(1).max(1000).refine(value=>!value.startsWith('/')&&!value.includes('\\')&&!value.split('/').some(p=>p==='..'||p==='.')&&!/[\r\n\0]/.test(value));
/** Persisted permissions fail closed if malformed; truthy strings must not grant access. */
export const tutorPairingSchema=z.object({
  tokenHash:z.string().regex(/^[a-f0-9]{64}$/),
  grant:z.object({clientId:id,name:z.string().min(1).max(120),createdAt:z.string().datetime(),
    targets:z.array(id).max(1000),documents:z.array(path).max(1000),humanObjectIds:z.array(id).max(20000),
    read:z.boolean(),write:z.boolean(),learningMemory:z.boolean(),learningEvidence:z.boolean().default(false),
    communication:z.boolean().default(false),communicationIdentity:communicationIdentitySchema.optional()})
    .superRefine((grant,ctx)=>{if(grant.communication&&!grant.communicationIdentity)ctx.addIssue({code:'custom',message:'communication-identity-required'});})
});

import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type { TutorClientGrant } from "./tutor-mcp.js";
export type TutorPairing = {grant:TutorClientGrant;tokenHash:string};
const digest=(token:string)=>createHash("sha256").update(token).digest("hex");
export function createTutorPairing(grant:TutorClientGrant):{record:TutorPairing;token:string}{
  const token=randomBytes(32).toString("hex");return {record:{grant:structuredClone(grant),tokenHash:digest(token)},token};
}
export function authenticateTutorClient(token:string,records:readonly TutorPairing[]):TutorClientGrant|undefined{
  if(token.length>256)return;
  const candidate=Buffer.from(digest(token),"hex");
  return records.find(record=>/^[a-f0-9]{64}$/.test(record.tokenHash)&&timingSafeEqual(candidate,Buffer.from(record.tokenHash,"hex")))?.grant;
}

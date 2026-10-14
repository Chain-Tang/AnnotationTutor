/** References contain no key material and can safely travel with Vault settings. */
export const credentialSlots = ["apiKey", "boardImageApiKey", "tutorRemoteToken", "mcpServersJson"] as const;
export type CredentialSlot = typeof credentialSlots[number];
export type CredentialReference = { version: 1; id: string; slot: CredentialSlot; binding: string };
export type CredentialReferences = CredentialReference[];
export function isCredentialReference(value: unknown): value is CredentialReference {
  if (!value || typeof value !== "object") return false;
  const ref=value as Partial<CredentialReference>;
  return ref.version===1 && typeof ref.id==="string" && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(ref.id)
    && credentialSlots.includes(ref.slot as CredentialSlot) && typeof ref.binding==="string" && /^[0-9a-f]{64}$/.test(ref.binding);
}
export function normalizeCredentialReferences(value: unknown): CredentialReferences {
  if (!Array.isArray(value)) return [];
  const seen=new Set<string>();
  return value.filter(isCredentialReference).filter(ref=>{const key=`${ref.slot}:${ref.binding}`;if(seen.has(key))return false;seen.add(key);return true;})
    .map(({version,id,slot,binding})=>({version,id,slot,binding}));
}

import { createApprovedDomain, listApprovedDomains } from '../../../../db';
import { ADMIN_NO_STORE_HEADERS, authorizeAdminRequest, readBoundedJson } from '../../../../lib/security/admin-api';

function normalizeDomain(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const domain = value.normalize('NFKC').trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\/$/, '');
  return /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(domain) ? domain : null;
}
export async function GET(request: Request) { const auth=await authorizeAdminRequest(request); if('response' in auth)return auth.response; return Response.json({domains:await listApprovedDomains()},{headers:ADMIN_NO_STORE_HEADERS}); }
export async function POST(request: Request) { const auth=await authorizeAdminRequest(request,true); if('response' in auth)return auth.response; const body=await readBoundedJson(request,2048); const raw=body&&typeof body==='object'?(body as Record<string,unknown>).domain:null; const values=typeof raw==='string'?raw.split(/[\n,]+/).map((value)=>value.trim()).filter(Boolean):[]; const domains=[...new Set(values.map(normalizeDomain))]; if(!values.length||domains.some((domain)=>!domain)||domains.length>20)return Response.json({error:'Enter up to 20 valid hostnames separated by commas or new lines.'},{status:400,headers:ADMIN_NO_STORE_HEADERS}); let created=0; for(const domain of domains as string[]){try{await createApprovedDomain(domain,auth.user);created++;}catch{/* Existing domains remain unchanged. */}} return Response.json({created,total:domains.length},{status:created?201:200,headers:ADMIN_NO_STORE_HEADERS}); }

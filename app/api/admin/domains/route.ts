import { createApprovedDomain, listApprovedDomains } from '../../../../db';
import { ADMIN_NO_STORE_HEADERS, authorizeAdminRequest, readBoundedJson } from '../../../../lib/security/admin-api';

function normalizeDomain(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const domain = value.normalize('NFKC').trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\/$/, '');
  return /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(domain) ? domain : null;
}
export async function GET(request: Request) { const auth=await authorizeAdminRequest(request); if('response' in auth)return auth.response; return Response.json({domains:await listApprovedDomains()},{headers:ADMIN_NO_STORE_HEADERS}); }
export async function POST(request: Request) { const auth=await authorizeAdminRequest(request,true); if('response' in auth)return auth.response; const body=await readBoundedJson(request,1024); const domain=normalizeDomain(body && typeof body==='object' ? (body as Record<string,unknown>).domain : null); if(!domain)return Response.json({error:'Enter a valid hostname only, such as player.example.com.'},{status:400,headers:ADMIN_NO_STORE_HEADERS}); try{await createApprovedDomain(domain,auth.user);return Response.json({created:true},{status:201,headers:ADMIN_NO_STORE_HEADERS});}catch{return Response.json({error:'That domain already exists.'},{status:409,headers:ADMIN_NO_STORE_HEADERS});} }

// storage adapter: Upstash Redis (Vercel Marketplace KV) when provisioned,
// falling back to Vercel Blob. Payloads are gzip+base64 to keep bandwidth low —
// the Blob free tier died in ~36h of chatty list()/put() traffic, so the design
// rule here is: tiny meta reads, compressed bodies, as few billable ops as possible.
import { gzipSync, gunzipSync } from 'node:zlib';

const R_URL = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
const R_TOK = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;
export const backend = (R_URL && R_TOK) ? 'redis' : 'blob';

async function rcmd(cmd){
  const r = await fetch(R_URL, { method: 'POST',
    headers: { authorization: `Bearer ${R_TOK}`, 'content-type': 'application/json' },
    body: JSON.stringify(cmd) });
  const j = await r.json();
  if (j.error) throw new Error('redis: ' + j.error);
  return j.result;
}
const pack = obj => gzipSync(JSON.stringify(obj)).toString('base64');
const unpack = s => JSON.parse(gunzipSync(Buffer.from(s, 'base64')).toString());

export async function readJson(key){
  if (backend === 'redis'){
    const v = await rcmd(['GET', key]);
    return v ? unpack(v) : null;
  }
  const { list } = await import('@vercel/blob');
  const { blobs } = await list({ prefix: key });
  const b = blobs.find(x => x.pathname === key);
  if (!b) return null;
  const r = await fetch(b.url + '?v=' + Date.now());
  if (!r.ok) return null;
  return r.json();
}

export async function writeJson(key, obj){
  if (backend === 'redis'){
    await rcmd(['SET', key, pack(obj)]);
    return;
  }
  const { put } = await import('@vercel/blob');
  await put(key, JSON.stringify(obj), { access: 'public',
    addRandomSuffix: false, contentType: 'application/json', cacheControlMaxAge: 60 });
}

import { put, list } from '@vercel/blob';

// blob paths are stable (no random suffix); reads cache-bust because the
// collector re-reads its own writes within the CDN's minimum cache window
export async function readJson(path){
  const { blobs } = await list({ prefix: path, limit: 5 });
  const b = blobs.find(x => x.pathname === path);
  if (!b) return null;
  const r = await fetch(`${b.url}?v=${Date.now()}`, { cache: 'no-store' });
  return r.ok ? r.json() : null;
}

export function writeJson(path, obj){
  return put(path, JSON.stringify(obj), {
    access: 'public', addRandomSuffix: false,
    contentType: 'application/json', cacheControlMaxAge: 60,
  });
}

// serves the collector's latest snapshot; edge-cached briefly so visitor
// traffic costs almost nothing
import { readJson } from './_store.js';

export default async function handler(req, res){
  try{
    const s = await readJson('snap.json');
    res.setHeader('cache-control', 's-maxage=45, stale-while-revalidate=600');
    if (!s) return res.status(404).json({ ok: false, err: 'no snapshot yet' });
    return res.json(s);
  }catch(e){
    return res.status(500).json({ ok: false, err: String(e && e.message || e) });
  }
}

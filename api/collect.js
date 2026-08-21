// WIPEOUT collector — runs on every ping (open clients each minute + a GitHub
// Action every 5 minutes as the always-on baseline). Throttled to one real run
// per ~minute. Each run: sweeps a slice of Hyperliquid wallets (near-liq first),
// captures Lighter liquidations (WS listen + REST backfill), and publishes one
// compact snapshot that the page loads at boot.
//
// Storage discipline (the old version burned the Blob free tier in ~36h):
// meta.json is a tiny throttle stamp read first; state/universe live in warm
// instance memory between runs and are only re-read on cold starts; everything
// is written gzipped through the adapter.
import { readJson, writeJson } from './_store.js';

const HL = 'https://api.hyperliquid.xyz/info';
const LI = 'https://mainnet.zklighter.elliot.ai';
const BIN = t => Math.floor(t / 30000);
const DAY_BINS = 2880;

// warm-instance cache: with steady pings the same instance keeps serving,
// so most runs never re-read state or the universe from storage
const MEM = { state: null, stamped: 0, uni: null, uniAt: 0 };

async function hl(body){
  const r = await fetch(HL, { method: 'POST',
    headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  if (!r.ok) throw new Error('hl ' + r.status);
  return r.json();
}

export default async function handler(req, res){
  try{
    if ((req.query?.task) === 'universe') return await universe(res);
    return await collect(res);
  }catch(e){
    return res.status(500).json({ ok: false, err: String(e && e.message || e) });
  }
}

// daily: refresh the wallet universe from the ~35MB leaderboard.
// Only the hot ring + names are stored — the cold long-tail sweep is a
// browser-side job (open tabs download the full leaderboard themselves).
async function universe(res){
  const r = await fetch('https://stats-data.hyperliquid.xyz/Mainnet/leaderboard');
  const rows = (await r.json()).leaderboardRows;
  const slim = rows.map(x => {
    const wk = Object.fromEntries(x.windowPerformances || []).week || {};
    return { a: x.ethAddress.toLowerCase(), v: parseFloat(x.accountValue) || 0,
             vl: parseFloat(wk.vlm) || 0, n: x.displayName || null };
  });
  slim.sort((a, b) => b.v - a.v);
  const hotSet = new Set(slim.slice(0, 3600).map(x => x.a));
  for (const x of slim.slice().sort((a, b) => b.vl - a.vl).slice(0, 1000)) hotSet.add(x.a);
  const hot = [], names = {};
  for (const x of slim){ if (!hotSet.has(x.a)) continue;
    hot.push(x.a); if (x.n) names[x.a] = x.n; }
  const uni = { ts: Date.now(), hot, names, total: slim.length };
  await writeJson('universe.json', uni);
  MEM.uni = uni; MEM.uniAt = Date.now();
  return res.json({ ok: true, total: slim.length, hot: hot.length });
}

async function collect(res){
  // cheap throttle: a ~60-byte stamp, not the whole state
  const meta = await readJson('meta.json') || { lastRun: 0 };
  if (Date.now() - meta.lastRun < 50e3)
    return res.json({ ok: true, skipped: true, ageS: Math.round((Date.now() - meta.lastRun) / 1000) });

  let st;
  if (MEM.state && MEM.stamped === meta.lastRun) st = MEM.state;   // warm path: nothing else wrote since we did
  else st = await readJson('state.json') ||
    { lastRun: 0, hotIdx: 0, harvestIdx: 0,
      accounts: {}, bins: {}, watched: [], liLast: {}, biasHist: [], harvest: [] };

  if (!MEM.uni || Date.now() - MEM.uniAt > 6 * 3600e3){
    MEM.uni = await readJson('universe.json'); MEM.uniAt = Date.now();
  }
  const uni = MEM.uni;
  if (!uni) return res.status(503).json({ ok: false, err: 'no universe — call ?task=universe first' });

  const t0 = Date.now();
  const prevRun = meta.lastRun; st.lastRun = t0;

  const addLiq = (ts, venue, side, usd) => {
    if (!usd || !isFinite(usd)) return;
    const b = st.bins[BIN(ts)] ??= {};
    const v = b[venue] ??= { long: 0, short: 0 };
    v[side] = Math.round(v[side] + usd);
  };

  // --- market meta: marks for every live coin ---
  const [hlMeta, ctxs] = await hl({ type: 'metaAndAssetCtxs' });
  const markByHl = {}; const active = [];
  hlMeta.universe.forEach((u, i) => {
    if (u.isDelisted) return; const c = ctxs[i]; if (!c) return;
    markByHl[u.name] = parseFloat(c.markPx);
    const vol = parseFloat(c.dayNtlVlm) || 0;
    if (vol > 1e6) active.push({ hl: u.name, vol });
  });
  active.sort((a, b) => b.vol - a.vol);

  // --- Lighter: WS listen for ~32s + recentTrades backfill, deduped by trade_id ---
  const obs = (await (await fetch(LI + '/api/v1/orderBooks')).json()).order_books || [];
  const liMkts = [];
  for (const a of active){
    const base = /^k[A-Z0-9]/.test(a.hl) ? a.hl.slice(1) : a.hl;
    const o = obs.find(o => o.symbol === base) || obs.find(o => o.symbol === '1000' + base);
    if (o) liMkts.push(o.market_id);
  }
  const liSet = new Set(liMkts);
  const runSeen = new Set(); const maxIds = {};
  const onTrade = t => {
    if (!t || !t.type || t.type === 'trade' || !liSet.has(t.market_id)) return;
    const tid = +t.trade_id;
    if (tid <= (st.liLast[t.market_id] || 0) || runSeen.has(tid)) return;
    runSeen.add(tid);
    maxIds[t.market_id] = Math.max(maxIds[t.market_id] || 0, tid);
    const side = t.is_maker_ask === true ? 'short' : 'long';
    const ts = t.timestamp > 1e12 ? +t.timestamp : t.timestamp * 1000;
    addLiq(ts, 'lighter', side, parseFloat(t.usd_amount) || 0);
  };
  const wsDone = new Promise(resolve => {
    let ws; const done = () => { try{ ws && ws.close(); }catch{} resolve(); };
    const to = setTimeout(done, 32000);
    try{
      ws = new WebSocket(LI.replace('https', 'wss') + '/stream');
      ws.onopen = () => liMkts.forEach(id =>
        ws.send(JSON.stringify({ type: 'subscribe', channel: 'trade/' + id })));
      ws.onmessage = ev => { try{
        const d = JSON.parse(ev.data);
        if (d.trades) for (const t of d.trades) onTrade(t);
      }catch{} };
      ws.onerror = () => {}; ws.onclose = () => { clearTimeout(to); resolve(); };
    }catch(e){ clearTimeout(to); resolve(); }
  });
  const restBackfill = (async () => {
    for (let i = 0; i < liMkts.length; i += 12){
      await Promise.all(liMkts.slice(i, i + 12).map(async id => {
        try{
          const j = await (await fetch(`${LI}/api/v1/recentTrades?market_id=${id}&limit=100`)).json();
          for (const t of j.trades || []) onTrade(t);
          for (const t of j.trades || []) maxIds[id] = Math.max(maxIds[id] || 0, +t.trade_id);
        }catch{}
      }));
    }
  })();

  // --- Hyperliquid sweep slice: near-liq first, then hot ring / harvested actives ---
  const nearList = [];
  for (const [a, acc] of Object.entries(st.accounts)){
    let best = 1;
    for (const p of acc[1]){ const [coin,,, liq] = p; if (!liq) continue;
      const mark = markByHl[coin]; if (!mark) continue;
      const d = Math.abs(mark - liq) / mark; if (d < best) best = d; }
    if (best < 0.05) nearList.push([a, best]);
  }
  nearList.sort((a, b) => a[1] - b[1]);
  const targets = new Set(nearList.slice(0, 90).map(x => x[0]));
  for (let i = 0; i < 65 && uni.hot.length; i++)
    targets.add(uni.hot[(st.hotIdx + i) % uni.hot.length]);
  st.hotIdx = (st.hotIdx + 65) % Math.max(1, uni.hot.length);
  for (let i = 0; i < 35 && st.harvest.length; i++)
    targets.add(st.harvest[(st.harvestIdx + i) % st.harvest.length]);
  st.harvestIdx = (st.harvestIdx + 35) % Math.max(1, st.harvest.length);

  const list = [...targets];
  let scanned = 0, wipes = 0;
  const scanOne = async a => {
    let j; try{ j = await hl({ type: 'clearinghouseState', user: a }); }catch{ return; }
    scanned++;
    const av = Math.round(parseFloat(j.marginSummary?.accountValue) || 0);
    const prev = st.accounts[a];
    const positions = (j.assetPositions || []).map(x => x.position).map(p => {
      const szi = parseFloat(p.szi);
      return [p.coin, szi, parseFloat(p.entryPx),
        p.liquidationPx ? parseFloat(p.liquidationPx) : 0,
        Math.round(Math.abs(parseFloat(p.positionValue))), p.leverage?.value || 0,
        p.leverage?.type === 'cross' ? 1 : 0, Math.round(parseFloat(p.unrealizedPnl) || 0), 0];
    });
    if (prev) for (const pp of prev[1]){
      const [coin, szi,, liq, val] = pp; if (!liq) continue;
      const still = positions.find(x => x[0] === coin && Math.sign(x[1]) === Math.sign(szi));
      const mark = markByHl[coin];
      if (!still && mark && Math.abs(mark - liq) / mark < 0.03){
        wipes++; addLiq(Date.now(), 'hyperliquid', szi > 0 ? 'long' : 'short', val);
      }
    }
    if (prev) for (const np of positions){
      const was = prev[1].find(x => x[0] === np[0] && Math.sign(x[1]) === Math.sign(np[1]));
      np[8] = was ? (was[8] || 0) : Date.now();   // openedTs carried across scans
    }
    if (positions.length) st.accounts[a] = [av, positions];
    else delete st.accounts[a];
  };
  for (let i = 0; i < list.length && Date.now() - t0 < 40000; i += 8)
    await Promise.all(list.slice(i, i + 8).map(scanOne));

  // --- harvest fresh active wallets from the HL tape (they carry the near-mark liqs) ---
  try{
    const hSet = new Set(st.harvest);
    for (const a of active.slice(0, 4)){
      const tr = await hl({ type: 'recentTrades', coin: a.hl });
      for (const t of tr || []) for (const u of t.users || []){
        const lu = u.toLowerCase();
        if (!hSet.has(lu)){ hSet.add(lu); st.harvest.push(lu); }
      }
    }
    if (st.harvest.length > 1500) st.harvest = st.harvest.slice(-1500);
  }catch{}

  await wsDone; await restBackfill;
  for (const [mid, id] of Object.entries(maxIds))
    st.liLast[mid] = Math.max(st.liLast[mid] || 0, id);

  // --- coverage: which 30s slices this run actually witnessed ---
  const nowB = BIN(Date.now());
  const fromB = (prevRun && t0 - prevRun < 6.5 * 60e3) ? BIN(prevRun) : BIN(t0);
  const wset = new Set(st.watched);
  for (let b = fromB; b <= nowB; b++) wset.add(b);
  st.watched = [...wset].filter(b => b >= nowB - DAY_BINS).sort((a, b) => a - b);
  for (const k of Object.keys(st.bins)) if (+k < nowB - DAY_BINS) delete st.bins[k];

  // --- whale bias history point (accounts >= $5M) ---
  let bl = 0, bs = 0;
  for (const acc of Object.values(st.accounts)){
    if (acc[0] < 5e6) continue;
    for (const p of acc[1]){ if (p[1] > 0) bl += p[4]; else bs += p[4]; }
  }
  if (bl + bs) st.biasHist.push({ t: t0, l: Math.round(bl), s: Math.round(bs) });
  st.biasHist = st.biasHist.filter(x => t0 - x.t < 24 * 3600e3).slice(-720);

  // --- publish snapshot ---
  const names = {};
  for (const a of Object.keys(st.accounts)) if (uni.names[a]) names[a] = uni.names[a];
  const snap = { ts: t0, universeN: uni.total, hot: uni.hot.slice(0, 1500), names,
    accounts: st.accounts, bins: st.bins, watched: st.watched, biasHist: st.biasHist };
  await writeJson('snap.json', snap);
  await writeJson('state.json', st);
  await writeJson('meta.json', { lastRun: t0 });
  MEM.state = st; MEM.stamped = t0;
  return res.json({ ok: true, ms: Date.now() - t0, scanned, wipes,
    liqsSeen: runSeen.size, accounts: Object.keys(st.accounts).length });
}

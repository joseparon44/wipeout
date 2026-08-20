// cron target: daily universe refresh (Vercel crons can't pass query params)
import handler from './collect.js';
export default function universeHandler(req, res){
  req.query = { ...(req.query || {}), task: 'universe' };
  return handler(req, res);
}

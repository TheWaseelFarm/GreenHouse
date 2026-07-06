// Resolve which sub-action a consolidated /api function should run.
//
// Vercel counts every .js file under /api as a Serverless Function (max 12 on
// the Hobby plan), so related endpoints are grouped behind one dispatcher and
// routed with `dest: "/api/<group>.js?_a=<action>"` in vercel.json. This reads
// the action robustly whether Vercel exposes it via req.query, the query in
// req.url, or (locally) the last path segment.
function resolveAction(req) {
  try {
    const u = new URL(req.url || '', 'http://x');
    if (req.query && (req.query._a || req.query.action)) return req.query._a || req.query.action;
    const q = u.searchParams.get('_a');
    if (q) return q;
    return u.pathname.split('/').filter(Boolean).pop() || '';
  } catch {
    return (req.query && (req.query._a || req.query.action)) || '';
  }
}

module.exports = { resolveAction };

// Consolidated auth function. Routes /api/auth/* to one Serverless Function.
const { resolveAction } = require('../_lib/dispatch');

const handlers = {
  login: require('../_lib/handlers/login'),
  logout: require('../_lib/handlers/logout'),
  check: require('../_lib/handlers/check'),
  'request-access': require('../_lib/handlers/request-access'),
  'access-requests': require('../_lib/handlers/access-requests'),
};

module.exports = (req, res) => {
  const handler = handlers[resolveAction(req)];
  if (!handler) return res.status(404).json({ error: 'Not found' });
  return handler(req, res);
};

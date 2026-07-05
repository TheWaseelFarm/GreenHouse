// Consolidated SwitchBot function. Routes /api/devices and /api/status.
const { resolveAction } = require('../_lib/dispatch');

const handlers = {
  devices: require('../_lib/handlers/devices'),
  status: require('../_lib/handlers/status'),
};

module.exports = (req, res) => {
  const handler = handlers[resolveAction(req)];
  if (!handler) return res.status(404).json({ error: 'Not found' });
  return handler(req, res);
};

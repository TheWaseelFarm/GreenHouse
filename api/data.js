// Consolidated Supabase data function. Routes the read/write data endpoints.
const { resolveAction } = require('../_lib/dispatch');

const handlers = {
  history: require('../_lib/handlers/history'),
  'save-reading': require('../_lib/handlers/save-reading'),
  incidents: require('../_lib/handlers/incidents'),
  council: require('../_lib/handlers/council'),
  'field-log-save': require('../_lib/handlers/field-log-save'),
  'field-log-list': require('../_lib/handlers/field-log-list'),
};

module.exports = (req, res) => {
  const handler = handlers[resolveAction(req)];
  if (!handler) return res.status(404).json({ error: 'Not found' });
  return handler(req, res);
};

const fs = require('fs');
const path = require('path');

// GET /api/apps          -> full manifest
// GET /api/apps?id=xxx   -> single app entry
module.exports = function handler(req, res) {
  const file = path.join(process.cwd(), 'public', 'apks', 'manifest.json');
  let manifest = { apps: [], updated: '' };
  try {
    manifest = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    res.status(200).json({ apps: [], updated: '', error: 'manifest missing' });
    return;
  }
  const id = (req.query && req.query.id) || '';
  if (id) {
    const app = (manifest.apps || []).find(a => a.id === id);
    res.status(200).json(app || { error: 'not found', id });
    return;
  }
  res.status(200).json(manifest);
};

import express from 'express';
import { get } from '../db.js';
import { HttpError } from './auth.js';
import { listPlugins, loadPlugins, setPluginEnabled } from '../plugins.js';

/** The Plugins page. Anyone signed in can look; only the person who created the first account can change anything. */
export const pluginsRouter = express.Router();

async function requireOwner(req) {
  const first = await get('SELECT id FROM users ORDER BY created_at, id LIMIT 1');
  if (first?.id !== req.user.id) throw new HttpError(403, 'Only the owner of this LiteForeFlow (the first account) can turn plugins on or off');
}

pluginsRouter.get('/', (req, res) => res.json(listPlugins()));

pluginsRouter.post('/reload', async (req, res) => {
  await requireOwner(req);
  res.json(await loadPlugins());
});

pluginsRouter.post('/:id/:action(enable|disable)', async (req, res) => {
  await requireOwner(req);
  res.json(await setPluginEnabled(req.params.id, req.params.action === 'enable'));
});

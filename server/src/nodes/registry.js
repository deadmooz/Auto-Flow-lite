/*
 * Declarative node SDK. A node is a plain object:
 *   { type, name, group, icon, description, isTrigger?, inputs?, outputs?, credentialType?,
 *     properties: [{ name, label, type, default, options?, showIf?, required?, placeholder?, help? }],
 *     executeItem(ctx, item, i)  -> object | object[] | null     (runs once per input item)
 *     execute(ctx, inputs)       -> items[][]                    (full control, one array per output)
 *   }
 * Property types: string | text | number | boolean | options | json | code | keyvalue | conditions | schedule | timezone
 *   | fields   (one input per column the service reports; the node needs loadFields)
 * Friendly dropdowns: give a property `dynamic: true` (optionally `dynamicIf: { otherProp: value }`) and add
 *   loadOptions(ctx, propName) -> [{ value, label }]   so the editor can fill the list from the live service.
 *   loadFields(ctx, propName)  -> [{ name, label, type, options? }]   for `fields` properties.
 *   ctx there has: param(name), credential(), http(opts).
 * `showIf: { otherProp: value | [values] }` toggles visibility in the editor.
 * Adding an integration is one object in apps.js.
 */
const registry = new Map();

export function defineNode(def) {
  registry.set(def.type, { inputs: 1, outputs: 1, properties: [], ...def });
}

export const getNodeType = (type) => registry.get(type);
export const hasNodeType = (type) => registry.has(type);

/** Takes away every node a plugin added (used when a plugin is switched off). */
export function removePluginNodes(pluginId) {
  for (const [type, def] of registry) if (def.plugin === pluginId) registry.delete(type);
}

/** JSON-safe description of every node type, for the editor palette. */
export function listNodeTypes() {
  // eslint-disable-next-line no-unused-vars
  return [...registry.values()].map(({ execute, executeItem, loadOptions, loadFields, ...pub }) => pub);
}

export function withDefaults(def, parameters = {}) {
  const out = { ...parameters };
  for (const p of def.properties) if (out[p.name] === undefined && p.default !== undefined) out[p.name] = p.default;
  return out;
}

export const credentialProperty = (credentialType) => ({
  name: 'credential', label: 'Credential', type: 'credential', credentialType, required: true,
});

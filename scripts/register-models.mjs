#!/usr/bin/env node
// Register the model providers from config/models.json (or a file you pass) in TrueForge.
// ${ENV_VAR} placeholders are filled from the environment, so keys never live in the repo.
//
//   cp config/models.example.json config/models.json   # then edit base URLs, delete unused providers
//   export FORGE_API_KEY=...                           # keys referenced in the file
//   node scripts/register-models.mjs [config/models.json] [--trueforge http://127.0.0.1:8790]
import { readFileSync } from 'node:fs';

const args = process.argv.slice(2);
const tfIndex = args.indexOf('--trueforge');
const trueforge = (tfIndex !== -1 ? args.splice(tfIndex, 2)[1] : 'http://127.0.0.1:8790').replace(/\/+$/, '');
const file = args[0] ?? 'config/models.json';

let config;
try {
  config = JSON.parse(readFileSync(file, 'utf8'));
} catch (err) {
  console.error(`Cannot read ${file}: ${err.message}\nCopy config/models.example.json to config/models.json first.`);
  process.exit(1);
}

const missing = new Set();
const fill = value =>
  typeof value === 'string'
    ? value.replace(/\$\{([A-Z0-9_]+)\}/g, (_, name) => {
        if (!process.env[name]) missing.add(name);
        return process.env[name] ?? '';
      })
    : Array.isArray(value)
      ? value.map(fill)
      : value && typeof value === 'object'
        ? Object.fromEntries(Object.entries(value).map(([k, v]) => [k, fill(v)]))
        : value;

let failures = 0;
for (const provider of config.providers ?? []) {
  if (String(provider.base_url ?? '').includes('<')) {
    console.log(`- ${provider.name}: skipped (base_url still has a placeholder)`);
    continue;
  }
  const manifest = fill(provider);
  if (missing.size) {
    console.log(`- ${provider.name}: skipped (export ${[...missing].join(', ')} first)`);
    missing.clear();
    continue;
  }
  const res = await fetch(`${trueforge}/api/v1/settings/model-providers`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ manifest }),
  }).catch(err => ({ ok: false, status: 0, text: async () => err.message }));
  if (res.ok) {
    const models = manifest.models.map(m => `${manifest.name ?? manifest.type}/${m.name}`).join(', ');
    console.log(`- ${provider.name}: registered -> ${models}`);
  } else {
    failures++;
    console.log(`- ${provider.name}: FAILED (HTTP ${res.status}) ${(await res.text()).slice(0, 300)}`);
  }
}
process.exit(failures ? 1 : 0);

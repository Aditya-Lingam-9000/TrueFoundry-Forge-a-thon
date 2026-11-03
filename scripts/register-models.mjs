#!/usr/bin/env node
// Register the model providers from config/models.json (or a file you pass) in TrueForge.
// ${ENV_VAR} placeholders are filled from the environment, so keys never live in the repo.
//
//   cp config/models.example.json config/models.json   # then edit base URLs, delete unused providers
//   node scripts/register-models.mjs [config/models.json] [--env ../.env] [--trueforge http://127.0.0.1:8790]
// Keys come from the environment, or from a .env file (KEY=value lines) given with --env. Exported
// variables win over the file. Key values are never printed.
import { readFileSync } from 'node:fs';

const args = process.argv.slice(2);
const option = name => {
  const i = args.indexOf(name);
  return i === -1 ? undefined : args.splice(i, 2)[1];
};
const trueforge = (option('--trueforge') ?? 'http://127.0.0.1:8790').replace(/\/+$/, '');
const envFile = option('--env');
const file = args[0] ?? 'config/models.json';

if (envFile) {
  let text;
  try {
    text = readFileSync(envFile, 'utf8');
  } catch (err) {
    console.error(`Cannot read ${envFile}: ${err.message}`);
    process.exit(1);
  }
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (m && !line.trimStart().startsWith('#') && process.env[m[1]] === undefined) {
      process.env[m[1]] = m[2].replace(/^(['"])(.*)\1$/, '$2');
    }
  }
}

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
  const label = provider.name ?? provider.type;
  if (String(provider.base_url ?? '').includes('<')) {
    console.log(`- ${label}: skipped (base_url still has a placeholder)`);
    continue;
  }
  const manifest = fill(provider);
  if (missing.size) {
    console.log(`- ${label}: skipped (export ${[...missing].join(', ')} first)`);
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
    console.log(`- ${label}: registered -> ${models}`);
  } else {
    failures++;
    console.log(`- ${label}: FAILED (HTTP ${res.status}) ${(await res.text()).slice(0, 300)}`);
  }
}
process.exit(failures ? 1 : 0);

/**
 * Crea el upload preset de Cloudinary para la galería de invitados.
 *
 * Uso:
 *   1. Rellena .env con tus credenciales (copia .env.example → .env)
 *   2. node scripts/setup-cloudinary.mjs
 */

import { readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

// Cargar .env manualmente (sin dependencias externas)
const __dir = dirname(fileURLToPath(import.meta.url));
try {
  const env = readFileSync(resolve(__dir, '../.env'), 'utf8');
  for (const line of env.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const [key, ...rest] = trimmed.split('=');
    process.env[key.trim()] = rest.join('=').trim();
  }
} catch {
  console.error('❌  No se encontró .env — copia .env.example → .env y rellénalo.');
  process.exit(1);
}

const cloudName = process.env.CLOUDINARY_CLOUD_NAME;
const apiKey    = process.env.CLOUDINARY_API_KEY;
const apiSecret = process.env.CLOUDINARY_API_SECRET;
const preset    = process.env.PUBLIC_CLOUDINARY_PRESET ?? 'wedding_invitados';

if (!cloudName || !apiKey || !apiSecret) {
  console.error('❌  Faltan CLOUDINARY_CLOUD_NAME, CLOUDINARY_API_KEY o CLOUDINARY_API_SECRET en .env');
  process.exit(1);
}

const auth = Buffer.from(`${apiKey}:${apiSecret}`).toString('base64');

console.log(`\n🔧  Configurando Cloudinary para "${cloudName}"…`);

// 1. Comprobar si el preset ya existe
const listRes  = await fetch(
  `https://api.cloudinary.com/v1_1/${cloudName}/upload_presets/${preset}`,
  { headers: { Authorization: `Basic ${auth}` } }
);

if (listRes.ok) {
  console.log(`✅  El preset "${preset}" ya existe. No es necesario crearlo de nuevo.`);
} else {
  // 2. Crear preset
  const createRes = await fetch(
    `https://api.cloudinary.com/v1_1/${cloudName}/upload_presets`,
    {
      method: 'POST',
      headers: {
        Authorization: `Basic ${auth}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        name    : preset,
        unsigned: true,
        folder  : 'wedding/invitados',
      }),
    }
  );

  const data = await createRes.json();

  if (createRes.ok) {
    console.log(`✅  Preset "${preset}" creado correctamente.`);
  } else {
    console.error('❌  Error al crear el preset:', JSON.stringify(data, null, 2));
    process.exit(1);
  }
}

// 3. Crear carpeta base (subiendo y borrando una imagen de 1px)
console.log('📁  Asegurando que la carpeta "wedding/invitados" existe…');
const placeholderRes = await fetch(
  `https://api.cloudinary.com/v1_1/${cloudName}/image/upload`,
  {
    method: 'POST',
    headers: { Authorization: `Basic ${auth}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      file  : 'data:image/gif;base64,R0lGODlhAQABAAAAACw=',
      folder: 'wedding/invitados',
      public_id: '_placeholder',
      overwrite: true,
    }),
  }
);
if (placeholderRes.ok) {
  // Borrar la imagen placeholder
  const { public_id } = await placeholderRes.json();
  const sig = await sign(`public_id=${public_id}&timestamp=${Math.floor(Date.now()/1000)}`, apiSecret);
  await fetch(`https://api.cloudinary.com/v1_1/${cloudName}/image/destroy`, {
    method: 'POST',
    headers: { Authorization: `Basic ${auth}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      public_id,
      timestamp: Math.floor(Date.now() / 1000),
      signature: sig,
      api_key  : apiKey,
    }),
  });
  console.log('✅  Carpeta lista.');
}

console.log(`
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
✅  Todo listo.

Añade estas variables en Netlify:
  Site configuration → Environment variables

  PUBLIC_CLOUDINARY_CLOUD_NAME = ${cloudName}
  PUBLIC_CLOUDINARY_PRESET     = ${preset}
  CLOUDINARY_CLOUD_NAME        = ${cloudName}
  CLOUDINARY_API_KEY           = ${apiKey}
  CLOUDINARY_API_SECRET        = (tu API Secret)

Luego haz un redeploy en Netlify y la galería estará lista.
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
`);

// SHA-1 para firma Cloudinary (sin dependencias externas)
async function sign(str, secret) {
  const enc  = new TextEncoder();
  const key  = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-1' }, false, ['sign']);
  const sig  = await crypto.subtle.sign('HMAC', key, enc.encode(str));
  return Array.from(new Uint8Array(sig)).map(b => b.toString(16).padStart(2, '0')).join('');
}

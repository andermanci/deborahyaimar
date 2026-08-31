/**
 * API de la galería — Aimar & Deborah
 *
 * Principio de diseño: los bytes NUNCA pasan por aquí.
 * El navegador sube directo a R2 con URLs prefirmadas y lee directo desde
 * fotos.deborahyaimar.com. Este Worker solo firma y mantiene el índice.
 * Por eso 150 invitados a la vez no lo mueven.
 */

import { AwsClient } from 'aws4fetch';

export interface Env {
  MEDIA: R2Bucket;
  DB: D1Database;
  SITIO: string;
  MEDIA_BASE: string;
  R2_ACCOUNT_ID: string;
  R2_BUCKET: string;
  R2_ACCESS_KEY_ID: string;
  R2_SECRET_ACCESS_KEY: string;
  ADMIN_PASSWORD: string;
}

// ── Límites ───────────────────────────────────────────────────────────
// El cliente ya redimensiona antes de subir; esto es la red de seguridad
// del servidor para que nadie suba un archivo arbitrario al bucket.
const TIPOS_OK: Record<string, number> = {
  'image/webp': 2_000_000,     // thumb y web salen del canvas como webp
  'image/jpeg': 2_000_000,     // fallback si el navegador no da webp
  'video/mp4': 100_000_000,
  'video/quicktime': 100_000_000,   // iPhone
  'video/webm': 100_000_000,        // Chrome en Android
};

const PART_SIZE = 5 * 1024 * 1024;   // mínimo de S3 para partes no finales
const MAX_PARTES = 20;               // → 100 MB de vídeo como techo
const TTL_INDICE = 15;               // segundos de frescura del índice
const FIRMA_TTL = 6 * 3600;          // 6 h: una subida lenta jamás caduca a medias

const ROLES = ['thumb', 'web', 'poster', 'video'] as const;
type Rol = (typeof ROLES)[number];

// ── Utilidades ────────────────────────────────────────────────────────

function cors(env: Env, extra: HeadersInit = {}): HeadersInit {
  return {
    'Access-Control-Allow-Origin': env.SITIO,
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Max-Age': '86400',
    ...extra,
  };
}

function json(data: unknown, env: Env, status = 200, extra: HeadersInit = {}): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', ...cors(env, extra) },
  });
}

function error(msg: string, env: Env, status = 400): Response {
  return json({ error: msg }, env, status);
}

function r2Client(env: Env): AwsClient {
  return new AwsClient({
    accessKeyId: env.R2_ACCESS_KEY_ID,
    secretAccessKey: env.R2_SECRET_ACCESS_KEY,
    service: 's3',
    region: 'auto',
  });
}

function r2Url(env: Env, key: string, query = ''): string {
  const base = `https://${env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com/${env.R2_BUCKET}/${key}`;
  return query ? `${base}?${query}` : base;
}

/** URL prefirmada para que el navegador haga PUT directo a R2. */
async function firmarPut(env: Env, key: string, query = ''): Promise<string> {
  const q = new URLSearchParams(query);
  q.set('X-Amz-Expires', String(FIRMA_TTL));
  const firmada = await r2Client(env).sign(r2Url(env, key, q.toString()), {
    method: 'PUT',
    aws: { signQuery: true },
  });
  return firmada.url;
}

/**
 * Huella del identificador de dispositivo.
 *
 * El índice es público y cacheado, así que NO puede llevar el device_id en
 * claro: cualquiera leería el de otro invitado y le borraría las fotos. Se
 * publica la huella, que sirve para marcar «esta es tuya» pero no para
 * suplantar a nadie. Para borrar, el cliente manda el id real y el servidor
 * lo compara con el guardado.
 */
async function huella(deviceId: string): Promise<string> {
  const datos = new TextEncoder().encode(`ad-galeria:${deviceId}`);
  const hash = await crypto.subtle.digest('SHA-256', datos);
  return Array.from(new Uint8Array(hash)).slice(0, 12)
    .map((b) => b.toString(16).padStart(2, '0')).join('');
}

function extension(contentType: string): string {
  if (contentType === 'video/mp4') return 'mp4';
  if (contentType === 'video/quicktime') return 'mov';
  if (contentType === 'video/webm') return 'webm';
  if (contentType === 'image/jpeg') return 'jpg';
  return 'webp';
}

// ── POST /firmar ──────────────────────────────────────────────────────
// Devuelve las URLs de subida. La clave la genera el servidor, así que un
// cliente malicioso solo puede añadir objetos nuevos, nunca pisar los ajenos.
async function firmar(req: Request, env: Env): Promise<Response> {
  let body: any;
  try { body = await req.json(); } catch { return error('JSON inválido', env); }

  const tipo = body?.tipo;
  if (tipo !== 'foto' && tipo !== 'video') return error('tipo debe ser foto o video', env);

  const archivos = Array.isArray(body?.archivos) ? body.archivos : null;
  if (!archivos?.length) return error('faltan archivos', env);

  const id = crypto.randomUUID();
  const prefijo = `invitados/${id}`;
  const subidas: any[] = [];

  for (const a of archivos) {
    const rol: Rol = a?.rol;
    const contentType: string = a?.contentType;
    const size: number = Number(a?.size);

    if (!ROLES.includes(rol)) return error(`rol desconocido: ${rol}`, env);
    const max = TIPOS_OK[contentType];
    if (!max) return error(`tipo de archivo no permitido: ${contentType}`, env);
    if (!Number.isFinite(size) || size <= 0 || size > max) {
      return error(`tamaño fuera de rango para ${rol}`, env);
    }

    const key = `${prefijo}/${rol}.${extension(contentType)}`;

    if (rol === 'video') {
      // Multipart: el navegador sube trozos de 5 MB y puede reanudar.
      const partes = Math.ceil(size / PART_SIZE);
      if (partes > MAX_PARTES) return error('vídeo demasiado grande', env);

      const cliente = r2Client(env);
      const creada = await cliente.fetch(r2Url(env, key, 'uploads'), {
        method: 'POST',
        headers: { 'Content-Type': contentType },
      });
      if (!creada.ok) return error('no se pudo iniciar la subida del vídeo', env, 502);

      const xml = await creada.text();
      const uploadId = xml.match(/<UploadId>([^<]+)<\/UploadId>/)?.[1];
      if (!uploadId) return error('respuesta inesperada de R2', env, 502);

      const urls: string[] = [];
      for (let n = 1; n <= partes; n++) {
        urls.push(await firmarPut(env, key, `partNumber=${n}&uploadId=${encodeURIComponent(uploadId)}`));
      }

      await env.DB.prepare(
        'insert into subidas_parciales (id, key, upload_id, created_at) values (?, ?, ?, ?)'
      ).bind(id, key, uploadId, Date.now()).run();

      subidas.push({ rol, key, uploadId, partSize: PART_SIZE, urls });
    } else {
      subidas.push({ rol, key, url: await firmarPut(env, key) });
    }
  }

  return json({ id, subidas }, env);
}

// ── POST /completar ───────────────────────────────────────────────────
// Cierra el multipart si lo hubo e inserta la fila del índice.
async function completar(req: Request, env: Env): Promise<Response> {
  let body: any;
  try { body = await req.json(); } catch { return error('JSON inválido', env); }

  const { id, tipo, nombre, device_id, key_thumb, key_web, key_poster } = body ?? {};
  if (typeof id !== 'string' || !id) return error('falta id', env);
  if (tipo !== 'foto' && tipo !== 'video') return error('tipo inválido', env);
  if (typeof key_thumb !== 'string' || typeof key_web !== 'string') {
    return error('faltan claves de archivo', env);
  }
  // Las claves las generó el servidor bajo invitados/<id>/: verifica que
  // el cliente no las haya cambiado por otras.
  for (const k of [key_thumb, key_web, key_poster].filter(Boolean)) {
    if (!String(k).startsWith(`invitados/${id}/`)) return error('clave no autorizada', env, 403);
  }

  // Cerrar el multipart del vídeo, si aplica.
  if (Array.isArray(body.partes) && body.partes.length) {
    const fila = await env.DB.prepare(
      'select key, upload_id from subidas_parciales where id = ?'
    ).bind(id).first<{ key: string; upload_id: string }>();
    if (!fila) return error('no hay subida parcial para ese id', env, 404);

    const xml =
      '<CompleteMultipartUpload>' +
      body.partes
        .map((p: any) => `<Part><PartNumber>${Number(p.n)}</PartNumber><ETag>${p.etag}</ETag></Part>`)
        .join('') +
      '</CompleteMultipartUpload>';

    const res = await r2Client(env).fetch(
      r2Url(env, fila.key, `uploadId=${encodeURIComponent(fila.upload_id)}`),
      { method: 'POST', body: xml, headers: { 'Content-Type': 'application/xml' } }
    );
    if (!res.ok) return error('no se pudo completar el vídeo', env, 502);

    await env.DB.prepare('delete from subidas_parciales where id = ?').bind(id).run();
  }

  await env.DB.prepare(
    `insert into media
       (id, tipo, origen, categoria, nombre, device_id,
        key_thumb, key_web, key_original, key_poster,
        duracion_s, ancho, alto, oculta, created_at)
     values (?, ?, 'invitado', null, ?, ?, ?, ?, null, ?, ?, ?, ?, 0, ?)`
  ).bind(
    id, tipo,
    (nombre ?? '').toString().slice(0, 60) || null,
    (device_id ?? '').toString().slice(0, 40) || null,
    key_thumb, key_web, key_poster ?? null,
    Number(body.duracion_s) || null,
    Number(body.ancho) || null,
    Number(body.alto) || null,
    Date.now()
  ).run();

  return json({ ok: true, id }, env);
}

// ── GET /indice.json ──────────────────────────────────────────────────
// LA RUTA CRÍTICA. Se cachea explícitamente en el borde: 150 invitados
// sondeando cuestan ~240 consultas/hora a D1 en lugar de 216.000.
// Si esta caché deja de funcionar, volvemos al bug que rompía la galería.
async function indice(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  const cache = caches.default;
  const cacheada = await cache.match(req);

  // La frescura la decide el Worker mirando la edad, no la caché.
  //
  // Antes esto era `if (cacheada) return cacheada;` con
  // `stale-while-revalidate` en la cabecera, y se formaba un bucle: el CDN
  // servía una copia vieja y revalidaba por detrás; esa revalidación entraba
  // aquí, encontraba la MISMA copia vieja en caches.default, la devolvía, y el
  // CDN la reguardaba como fresca. La edad se quedaba clavada y la galería
  // podía no actualizarse nunca: los invitados subían fotos y no las veían.
  if (cacheada) {
    const fecha = Date.parse(cacheada.headers.get('date') ?? '');
    const edad = Number.isFinite(fecha) ? (Date.now() - fecha) / 1000 : Infinity;
    if (edad < TTL_INDICE) return cacheada;
  }

  const url = new URL(req.url);
  const origen = url.searchParams.get('origen') === 'oficial' ? 'oficial' : 'invitado';

  const { results } = await env.DB.prepare(
    `select id, tipo, origen, categoria, nombre, device_id,
            key_thumb, key_web, key_poster, duracion_s, ancho, alto, created_at
       from media
      where oculta = 0 and origen = ?
      order by created_at desc
      limit 2000`
  ).bind(origen).all();

  const base = env.MEDIA_BASE;
  const items = await Promise.all((results ?? []).map(async (r: any) => ({
    id: r.id,
    tipo: r.tipo,
    categoria: r.categoria,
    nombre: r.nombre ?? '',
    deviceHash: r.device_id ? await huella(r.device_id) : '',
    thumb: `${base}/${r.key_thumb}`,
    web: `${base}/${r.key_web}`,
    poster: r.key_poster ? `${base}/${r.key_poster}` : null,
    duracion: r.duracion_s,
    ancho: r.ancho,
    alto: r.alto,
    ts: r.created_at,
  })));

  const res = json({ items, total: items.length }, env, 200, {
    // max-age=0 para el NAVEGADOR, s-maxage para el CDN, y NADA de
    // stale-while-revalidate. Ver la nota sobre el bucle de caché en indice().
    'Cache-Control': `public, max-age=0, s-maxage=${TTL_INDICE}`,
  });
  ctx.waitUntil(cache.put(req, res.clone()));
  return res;
}

// ── POST /borrar ──────────────────────────────────────────────────────
// El invitado puede quitar SUS fotos, sin contraseña. Se autoriza comparando
// el device_id que manda con el que quedó guardado al subirla.
async function borrar(req: Request, env: Env): Promise<Response> {
  let body: any;
  try { body = await req.json(); } catch { return error('JSON inválido', env); }

  const id = body?.id;
  const deviceId = body?.deviceId;
  if (typeof id !== 'string' || !id) return error('falta id', env);
  if (typeof deviceId !== 'string' || deviceId.length < 8) return error('falta deviceId', env);

  const fila = await env.DB.prepare('select device_id from media where id = ?')
    .bind(id).first<{ device_id: string | null }>();
  if (!fila) return error('esa foto no existe', env, 404);
  if (!fila.device_id || fila.device_id !== deviceId) {
    return error('esa foto no es tuya', env, 403);
  }

  await env.DB.prepare('update media set oculta = 1 where id = ?').bind(id).run();
  return json({ ok: true }, env);
}

// ── POST /moderar ─────────────────────────────────────────────────────
async function moderar(req: Request, env: Env): Promise<Response> {
  let body: any;
  try { body = await req.json(); } catch { return error('JSON inválido', env); }

  // Falla cerrado: si el secreto no está configurado, se rechaza todo.
  // Comparar sin esta guarda dejaba pasar `undefined === undefined`.
  const esperada = env.ADMIN_PASSWORD;
  if (typeof esperada !== 'string' || esperada.length === 0) {
    return error('moderación no configurada en el servidor', env, 503);
  }
  if (typeof body?.password !== 'string' || body.password !== esperada) {
    return error('no autorizado', env, 401);
  }
  if (typeof body?.id !== 'string' || !body.id) return error('falta id', env);

  const ocultar = body.ocultar === false ? 0 : 1;
  await env.DB.prepare('update media set oculta = ? where id = ?').bind(ocultar, body.id).run();
  return json({ ok: true }, env);
}

// ── Router ────────────────────────────────────────────────────────────

export default {
  async fetch(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const { pathname } = new URL(req.url);

    if (req.method === 'OPTIONS') return new Response(null, { headers: cors(env) });

    try {
      // HEAD se trata como GET: lo usan CDNs, monitores y `curl -I`.
      if (pathname === '/indice.json' && (req.method === 'GET' || req.method === 'HEAD')) {
        return await indice(req, env, ctx);
      }
      if (pathname === '/firmar'      && req.method === 'POST') return await firmar(req, env);
      if (pathname === '/completar'   && req.method === 'POST') return await completar(req, env);
      if (pathname === '/borrar'      && req.method === 'POST') return await borrar(req, env);
      if (pathname === '/moderar'     && req.method === 'POST') return await moderar(req, env);
    } catch (err) {
      return error(`fallo interno: ${err}`, env, 500);
    }

    return error('no encontrado', env, 404);
  },
};

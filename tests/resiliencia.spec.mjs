import { chromium } from 'playwright';
import { readFileSync } from 'fs';

const BASE = 'http://127.0.0.1:4321';
const fallos = [];
const ok = (m) => console.log(`  ✓ ${m}`);
const mal = (m) => { fallos.push(m); console.log(`  ✗ ${m}`); };
const FOTO = readFileSync('public/foto.jpg');

/** El nombre se pide una vez, en una hoja, después de elegir los archivos. */
async function rellenarNombre(pg, nombre) {
  const hoja = pg.locator('.hoja.abierta');
  if (await hoja.count()) {
    await pg.fill('#nombreInput', nombre);
    await pg.click('#hojaBoton');
  }
}

const navegador = await chromium.launch({ channel: 'chrome' });

async function nuevaPagina(ctx) {
  const page = await ctx.newPage();
  page.on('pageerror', (e) => mal(`error JS: ${e.message}`));
  await page.clock.install({ time: new Date('2026-09-12T18:00:00+02:00') });
  await page.route('**/indice.json*', (r) =>
    r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ items: [] }) }));
  return page;
}

// ══ A. Una subida que falla NUNCA dice "gracias" ══════════════════════
console.log('\nA) Subida que falla en R2');
{
  const ctx = await navegador.newContext({ viewport: { width: 390, height: 844 } });
  const page = await nuevaPagina(ctx);

  await page.route('**/firmar', (r) => r.fulfill({ status: 200, contentType: 'application/json',
    body: JSON.stringify({ id: 'x', subidas: [
      { rol: 'thumb', key: 'invitados/x/thumb.webp', url: `${BASE}/__put/thumb` },
      { rol: 'web',   key: 'invitados/x/web.webp',   url: `${BASE}/__put/web` }]}) }));
  // R2 rechaza siempre.
  await page.route('**/__put/**', (r) => r.fulfill({ status: 500, body: 'boom' }));
  await page.route('**/completar', (r) => r.fulfill({ status: 200, contentType: 'application/json', body: '{"ok":true}' }));

  await page.goto(`${BASE}/galeria/`, { waitUntil: 'networkidle' });
  await page.fill('#nombreInput', 'Ander');
  await page.setInputFiles('#selector', { name: 'f.jpg', mimeType: 'image/jpeg', buffer: FOTO });
  await rellenarNombre(page, 'Ander');

  // MAX_INTENTOS=6 con backoff exponencial. Con reloj falso hay que avanzarlo
  // repetidamente: un solo runFor no basta porque los timeouts se van creando
  // a medida que fallan los intentos.
  let informado = false;
  for (let i = 0; i < 40 && !informado; i++) {
    await page.clock.runFor(15_000);
    await page.waitForTimeout(120);
    informado = (await page.locator('#progresoTexto').textContent()).includes('fallida');
  }
  informado ? ok('informa de la subida fallida') : mal('no informó del fallo');

  const texto = await page.locator('#progresoTexto').textContent();
  texto.includes('Gracias') ? mal('¡dijo "Gracias" con una subida fallida!') : ok('NO dice "Gracias" (el bug nº3 está cerrado)');
  await page.locator('#progresoAccion').isVisible() ? ok('ofrece reintentar') : mal('no ofrece reintentar');
  const err = await page.locator('#progresoMotivo').textContent();
  err.trim() ? ok(`muestra el motivo: "${err.slice(0, 45)}…"`) : mal('no muestra el motivo');
  await ctx.close();
}

// ══ B. Se corta la red y vuelve ═══════════════════════════════════════
console.log('\nB) Se cae la red a mitad y luego vuelve');
{
  const ctx = await navegador.newContext({ viewport: { width: 390, height: 844 } });
  const page = await nuevaPagina(ctx);
  let caida = true;
  let subidas = 0;

  await page.route('**/firmar', (r) => caida ? r.abort('internetdisconnected')
    : r.fulfill({ status: 200, contentType: 'application/json',
        body: JSON.stringify({ id: 'y', subidas: [
          { rol: 'thumb', key: 'invitados/y/thumb.webp', url: `${BASE}/__put/thumb` },
          { rol: 'web',   key: 'invitados/y/web.webp',   url: `${BASE}/__put/web` }]}) }));
  await page.route('**/__put/**', (r) => { subidas++; return r.fulfill({ status: 200, headers: { ETag: '"e"' }, body: '' }); });
  await page.route('**/completar', (r) => r.fulfill({ status: 200, contentType: 'application/json', body: '{"ok":true}' }));

  await page.goto(`${BASE}/galeria/`, { waitUntil: 'networkidle' });
  await page.fill('#nombreInput', 'Marta');
  await page.setInputFiles('#selector', { name: 'f.jpg', mimeType: 'image/jpeg', buffer: FOTO });
  await rellenarNombre(page, 'Ander');
  await page.waitForTimeout(1500);

  const enCola = await page.locator('#progresoTexto').textContent();
  enCola.includes('Gracias') ? mal('se dio por hecho sin red') : ok('sin red, no da nada por hecho');

  // Vuelve la cobertura.
  caida = false;
  await page.evaluate(() => dispatchEvent(new Event('online')));
  await page.clock.runFor(60_000);
  await page.waitForFunction(() => document.getElementById('progresoTexto')?.textContent?.includes('Gracias'), { timeout: 30000 })
    .then(() => ok('al volver la red, la subida se completa sola'))
    .catch(() => mal('no reanudó al volver la red'));
  subidas === 2 ? ok('subió los 2 archivos') : mal(`subió ${subidas}`);
  await ctx.close();
}

// ══ C. Se cierra la pestaña a media subida ════════════════════════════
console.log('\nC) Se cierra la pestaña a media subida y se vuelve a abrir');
{
  // Mismo contexto = mismo IndexedDB, como un invitado que cierra y reabre.
  const ctx = await navegador.newContext({ viewport: { width: 390, height: 844 } });
  let permitir = false;
  let subidas = 0;

  const rutas = async (page) => {
    await page.route('**/firmar', (r) => permitir
      ? r.fulfill({ status: 200, contentType: 'application/json',
          body: JSON.stringify({ id: 'z', subidas: [
            { rol: 'thumb', key: 'invitados/z/thumb.webp', url: `${BASE}/__put/thumb` },
            { rol: 'web',   key: 'invitados/z/web.webp',   url: `${BASE}/__put/web` }]}) })
      : r.abort('internetdisconnected'));
    await page.route('**/__put/**', (r) => { subidas++; return r.fulfill({ status: 200, headers: { ETag: '"e"' }, body: '' }); });
    await page.route('**/completar', (r) => r.fulfill({ status: 200, contentType: 'application/json', body: '{"ok":true}' }));
  };

  const p1 = await nuevaPagina(ctx);
  await rutas(p1);
  await p1.goto(`${BASE}/galeria/`, { waitUntil: 'networkidle' });
  await p1.fill('#nombreInput', 'Jon');
  await p1.setInputFiles('#selector', { name: 'f.jpg', mimeType: 'image/jpeg', buffer: FOTO });
  await rellenarNombre(p1, 'Jon');
  await p1.waitForTimeout(1200);
  await p1.close();   // el invitado cierra la pestaña
  ok('pestaña cerrada con la subida a medias');

  permitir = true;
  const p2 = await nuevaPagina(ctx);
  await rutas(p2);
  await p2.goto(`${BASE}/galeria/`, { waitUntil: 'networkidle' });
  await p2.clock.runFor(60_000);
  await p2.waitForFunction(() => document.getElementById('progresoTexto')?.textContent?.includes('Gracias'), { timeout: 30000 })
    .then(() => ok('al reabrir, la cola retoma sola desde IndexedDB'))
    .catch(() => mal('la cola NO sobrevivió al cierre de pestaña'));
  subidas >= 2 ? ok(`completó la subida tras reabrir (${subidas} PUT)`) : mal(`solo ${subidas} PUT`);
  await ctx.close();
}

// ══ D. Una petición que se queda colgada (cobertura que se cae a medias) ══
console.log('\nD) La red se queda colgada a mitad de una subida');
{
  const ctx = await navegador.newContext({ viewport: { width: 390, height: 844 } });
  const page = await nuevaPagina(ctx);
  let colgar = true;
  const subidas = new Set();

  await page.route('**/firmar', (r) => r.fulfill({ status: 200, contentType: 'application/json',
    body: JSON.stringify({ id: 'h', subidas: [
      { rol: 'thumb', key: 'invitados/h/thumb.webp', url: `${BASE}/__put/thumb` },
      { rol: 'web',   key: 'invitados/h/web.webp',   url: `${BASE}/__put/web` }]}) }));

  // La primera petición NUNCA responde: es lo que mata a fetch sin plazo.
  await page.route('**/__put/**', async (r) => {
    if (colgar) { colgar = false; return; }        // sin fulfill: cuelga
    subidas.add(r.request().url());
    await r.fulfill({ status: 200, headers: { ETag: '"e"' }, body: '' });
  });
  await page.route('**/completar', (r) => r.fulfill({ status: 200, contentType: 'application/json', body: '{"ok":true}' }));

  await page.goto(`${BASE}/galeria/`, { waitUntil: 'networkidle' });
  await page.setInputFiles('#selector', { name: 'f.jpg', mimeType: 'image/jpeg', buffer: FOTO });
  await rellenarNombre(page, 'Colgado');

  // Con el plazo de 90 s más el backoff, hay que adelantar el reloj.
  let recuperado = false;
  for (let i = 0; i < 60 && !recuperado; i++) {
    await page.clock.runFor(20_000);
    await page.waitForTimeout(150);
    recuperado = (await page.locator('#progresoTexto').textContent()).includes('Gracias');
  }
  recuperado
    ? ok('la cola se recupera de una petición colgada y termina')
    : mal(`sigue atascada: "${await page.locator('#progresoTexto').textContent()}"`);
  await ctx.close();
}

// ══ E. Restos de una sesión anterior no deben inflar el contador ══════
console.log('\nE) Vuelves a subir tras una sesión anterior');
{
  const ctx = await navegador.newContext({ viewport: { width: 390, height: 844 } });
  let subidas = 0;

  const rutas = async (page) => {
    await page.route('**/firmar', (r) => r.fulfill({ status: 200, contentType: 'application/json',
      body: JSON.stringify({ id: 'x', subidas: [
        { rol: 'thumb', key: 'invitados/x/thumb.webp', url: `${BASE}/__put/t` },
        { rol: 'web',   key: 'invitados/x/web.webp',   url: `${BASE}/__put/w` }]}) }));
    await page.route('**/__put/**', (r) => { subidas++; return r.fulfill({ status: 200, headers: { ETag: '"e"' }, body: '' }); });
    await page.route('**/completar', (r) => r.fulfill({ status: 200, contentType: 'application/json', body: '{"ok":true}' }));
  };

  // Sesión 1: sube 2 fotos y se cierra la pestaña ANTES de que se limpien.
  const p1 = await nuevaPagina(ctx);
  await rutas(p1);
  await p1.goto(`${BASE}/galeria/`, { waitUntil: 'networkidle' });
  await p1.setInputFiles('#selector', [
    { name: 'a.jpg', mimeType: 'image/jpeg', buffer: FOTO },
    { name: 'b.jpg', mimeType: 'image/jpeg', buffer: FOTO },
  ]);
  await rellenarNombre(p1, 'Ander');
  await p1.waitForFunction(() => document.getElementById('progresoTexto')?.textContent?.includes('Gracias'), { timeout: 60000 });
  await p1.close();   // se cierra antes de los 3,5 s de limpieza
  ok('sesión 1: 2 fotos subidas y pestaña cerrada al momento');

  // Sesión 2: sube 1 sola. El contador debe decir 1, no 3.
  const p2 = await nuevaPagina(ctx);
  await rutas(p2);
  await p2.goto(`${BASE}/galeria/`, { waitUntil: 'networkidle' });
  await p2.waitForTimeout(1200);
  const alEntrar = await p2.locator('#progresoTexto').textContent();
  (alEntrar ?? '').trim() === '' ? ok('al volver no arrastra el progreso viejo') : mal(`arrastra: "${alEntrar}"`);

  await p2.setInputFiles('#selector', { name: 'c.jpg', mimeType: 'image/jpeg', buffer: FOTO });
  await p2.waitForFunction(() => document.getElementById('progresoTexto')?.textContent?.includes('Gracias'), { timeout: 60000 });
  const texto = await p2.locator('#progresoTexto').textContent();
  texto?.includes('1 archivo') || texto?.includes('Ya está')
    ? ok(`cuenta solo la nueva: "${texto}"`)
    : mal(`el contador arrastra lo viejo: "${texto}"`);
  await ctx.close();
}

await navegador.close();
console.log(`\n${'─'.repeat(52)}`);
console.log(fallos.length ? `❌ ${fallos.length} fallo(s)` : '✅ Resiliencia correcta');
process.exit(fallos.length ? 1 : 0);

import { chromium } from 'playwright';
import { readFileSync } from 'fs';

const BASE = 'http://127.0.0.1:4321';
const fallos = [];
const ok = (m) => console.log(`  ✓ ${m}`);
const mal = (m) => { fallos.push(m); console.log(`  ✗ ${m}`); };

/** El nombre se pide una vez, en una hoja, después de elegir los archivos. */
async function rellenarNombre(pg, nombre) {
  const hoja = pg.locator('.hoja.abierta');
  if (await hoja.count()) {
    await pg.fill('#nombreInput', nombre);
    await pg.click('#hojaBoton');
  }
}

const navegador = await chromium.launch({ channel: 'chrome' });
const ctx = await navegador.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
const page = await ctx.newPage();
page.on('pageerror', (e) => mal(`error JS en la página: ${e.message}`));

// Fijar el reloj al día de la boda para saltar la cuenta atrás.
await page.clock.setFixedTime(new Date('2026-09-12T18:00:00+02:00'));

// ── Mocks del backend ────────────────────────────────────────────────
let firmadoCon = null;
const partesRecibidas = [];
let completadoCon = null;

const indice = { items: [
  { id: 'a1', tipo: 'foto', categoria: null, nombre: '<img src=x onerror=alert(1)>', deviceId: 'd',
    thumb: `${BASE}/foto2.jpg`, web: `${BASE}/foto2.jpg`, poster: null, duracion: null, ancho: 1200, alto: 800, ts: 2 },
  { id: 'a2', tipo: 'video', categoria: null, nombre: 'Marta', deviceId: 'd',
    thumb: `${BASE}/foto3.jpg`, web: `${BASE}/nope.mp4`, poster: `${BASE}/foto3.jpg`, duracion: 12, ancho: 1080, alto: 1920, ts: 1 },
]};

await page.route('**/indice.json*', (r) =>
  r.fulfill({ status: 200, contentType: 'application/json',
    body: JSON.stringify(r.request().url().includes('oficial') ? { items: [] } : indice) }));

await page.route('**/firmar', async (r) => {
  firmadoCon = JSON.parse(r.request().postData());
  const subidas = firmadoCon.archivos.map((a) => ({ rol: a.rol, key: `invitados/nuevo/${a.rol}.webp`, url: `${BASE}/__put/${a.rol}` }));
  await r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ id: 'nuevo', subidas }) });
});
await page.route('**/__put/**', async (r) => {
  partesRecibidas.push(r.request().url());
  await r.fulfill({ status: 200, headers: { ETag: '"abc123"' }, body: '' });
});
await page.route('**/completar', async (r) => {
  completadoCon = JSON.parse(r.request().postData());
  await r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true }) });
});

// ── 1. Carga y estado inicial ────────────────────────────────────────
console.log('\n1) Carga de la galería el día de la boda');
await page.goto(`${BASE}/galeria/`, { waitUntil: 'networkidle' });

if (await page.locator('#preBoda').isHidden()) ok('la cuenta atrás está oculta'); else mal('sigue mostrando la cuenta atrás');
if (await page.locator('#postBoda').isVisible()) ok('la galería está visible'); else mal('la galería no aparece');

const tabActiva = await page.locator('.pestana.activa').getAttribute('data-cat');
tabActiva === 'invitados' ? ok('abre en la pestaña Invitados, no en una vacía') : mal(`abre en "${tabActiva}"`);

await page.waitForSelector('.tarjeta', { timeout: 5000 });
const n = await page.locator('.tarjeta').count();
n === 2 ? ok(`pinta las ${n} fotos del índice`) : mal(`pinta ${n} fotos, esperaba 2`);

// ── 2. XSS ───────────────────────────────────────────────────────────
console.log('\n2) Nombre malicioso de invitado');
const inyectadas = await page.locator('.tarjeta-quien img, .tarjeta img[src*="onerror"]').count();
inyectadas === 0 ? ok('el HTML del nombre NO se ejecuta') : mal('¡se inyectó HTML del nombre!');
const textoNombre = await page.locator('.tarjeta-quien').first().textContent();
textoNombre.includes('<img') ? ok('el nombre se muestra como texto plano') : mal(`nombre inesperado: ${textoNombre}`);

// ── 3. Vídeo ─────────────────────────────────────────────────────────
console.log('\n3) Tarjeta de vídeo');
(await page.locator('.insignia').count()) === 1 ? ok('el vídeo lleva insignia de vídeo') : mal('falta la insignia');
const dur = (await page.locator('.insignia').textContent())?.trim();
dur === '12s' ? ok('muestra la duración') : mal(`duración: ${dur}`);

// ── 4. Lightbox y swipe ──────────────────────────────────────────────
console.log('\n4) Lightbox');
await page.locator('.tarjeta').first().click();
await page.waitForSelector('.visor.abierto', { timeout: 3000 });
ok('abre al tocar una foto');
const srcAntes = await page.locator('#visorSlot img').getAttribute('src');
// Eventos táctiles reales: el handler escucha touchstart/touchend, no ratón.
await page.evaluate(() => {
  const lb = document.getElementById('visor');
  const toque = (x) => new Touch({ identifier: 1, target: lb, clientX: x, clientY: 400 });
  lb.dispatchEvent(new TouchEvent('touchstart', { touches: [toque(340)], bubbles: true }));
  lb.dispatchEvent(new TouchEvent('touchend', { changedTouches: [toque(40)], bubbles: true }));
});
await page.waitForTimeout(300);
const hayVideo = await page.locator('#visorSlot video').count();
hayVideo === 1 ? ok('el swipe avanza a la siguiente (el vídeo)') : mal('el swipe no avanzó');
await page.keyboard.press('Escape');
await page.locator('.visor.abierto').count() === 0 ? ok('Escape cierra') : mal('Escape no cierra');

// ── 5. Subida real de una foto grande ────────────────────────────────
console.log('\n5) Subida de una foto de 3536x2357');
await page.setInputFiles('#selector', {
  name: 'foto.jpg', mimeType: 'image/jpeg', buffer: readFileSync('public/foto.jpg'),
});
await rellenarNombre(page, 'Ander');
await page.waitForFunction(() => document.getElementById('progresoTexto')?.textContent?.includes('Gracias'), { timeout: 20000 });

if (!firmadoCon) mal('nunca se pidió firma');
else {
  const web = firmadoCon.archivos.find((a) => a.rol === 'web');
  const thumb = firmadoCon.archivos.find((a) => a.rol === 'thumb');
  ok(`web: ${(web.size / 1024).toFixed(0)} KB · ${web.contentType}`);
  ok(`thumb: ${(thumb.size / 1024).toFixed(0)} KB · ${thumb.contentType}`);
  web.size < 700_000 ? ok('web por debajo de 700 KB') : mal(`web demasiado grande: ${web.size}`);
  thumb.size < 80_000 ? ok('thumb por debajo de 80 KB') : mal(`thumb demasiado grande: ${thumb.size}`);
  web.contentType === 'image/webp' ? ok('convertida a webp') : mal(`formato ${web.contentType}`);
}
partesRecibidas.length === 2 ? ok('subió exactamente 2 archivos (thumb + web)') : mal(`subió ${partesRecibidas.length}`);
completadoCon?.ancho === 2560 ? ok(`redimensionada a ${completadoCon.ancho}px de lado largo`) : mal(`ancho ${completadoCon?.ancho}`);
completadoCon?.nombre === 'Ander' ? ok('registra el nombre') : mal('no registra el nombre');

// ── 6. Persistencia del nombre ───────────────────────────────────────
console.log('\n6) El nombre no se vuelve a pedir');
await page.reload({ waitUntil: 'networkidle' });
const guardado = await page.evaluate(() => localStorage.getItem('ad-nombre'));
guardado === 'Ander' ? ok('el nombre queda guardado') : mal(`guardó "${guardado}"`);

// Al elegir más archivos NO debe reaparecer la hoja: se sube directo.
firmadoCon = null;
await page.setInputFiles('#selector', { name: 'otra.jpg', mimeType: 'image/jpeg', buffer: readFileSync('public/foto3.jpg') });
await page.waitForTimeout(1500);
(await page.locator('.hoja.abierta').count()) === 0
  ? ok('no vuelve a pedir el nombre: sube directo')
  : mal('volvió a pedir el nombre');
await page.waitForFunction(() => document.getElementById('progresoTexto')?.textContent?.includes('Gracias'), { timeout: 20000 })
  .then(() => ok('la segunda subida se completa en un solo toque'))
  .catch(() => mal('la segunda subida no completó'));

await navegador.close();
console.log(`\n${'─'.repeat(50)}`);
console.log(fallos.length ? `❌ ${fallos.length} fallo(s)` : '✅ Todo correcto');
process.exit(fallos.length ? 1 : 0);

// El flujo completo en el motor de Safari (WebKit). La mayoría de invitados
// irán con iPhone, y hasta la víspera todo se probaba solo en Chrome: así se
// coló que Safari no genera WebP y sube JPEG tres veces más pesados.
import { webkit } from 'playwright';
import { readFileSync } from 'fs';

const BASE = 'http://127.0.0.1:4321';
const fallos = [];
const ok = (m) => console.log(`  ✓ ${m}`);
const mal = (m) => { fallos.push(m); console.log(`  ✗ ${m}`); };

const nav = await webkit.launch();
const ctx = await nav.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
const page = await ctx.newPage();
page.on('pageerror', (e) => mal(`error JS: ${e.message}`));

let firmado = null, completado = null, hayFoto = false;
await page.route('**/categorias.json*', (r) => r.fulfill({ status: 200, contentType: 'application/json', body: '{"categorias":[]}' }));
await page.route('**/indice.json*', (r) => r.fulfill({ status: 200, contentType: 'application/json',
  body: JSON.stringify({ items: (hayFoto && !r.request().url().includes('oficial')) ? [{
    id: 's1', tipo: 'foto', categoria: null, nombre: 'Safari', deviceHash: 'x', thumb: `${BASE}/foto2.jpg`,
    web: `${BASE}/foto2.jpg`, poster: null, duracion: null, ancho: 2560, alto: 1707, ts: 1 }] : [] }) }));
await page.route('**/firmar', async (r) => {
  firmado = JSON.parse(r.request().postData());
  await r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ id: 's1', subidas: [
    { rol: 'thumb', key: 'invitados/s1/thumb.jpg', url: `${BASE}/__put/t` },
    { rol: 'web',   key: 'invitados/s1/web.jpg',   url: `${BASE}/__put/w` }]}) });
});
await page.route('**/__put/**', (r) => r.fulfill({ status: 200, headers: { ETag: '"e"' }, body: '' }));
await page.route('**/completar', async (r) => { completado = JSON.parse(r.request().postData()); hayFoto = true;
  await r.fulfill({ status: 200, contentType: 'application/json', body: '{"ok":true}' }); });

console.log('\nSafari (WebKit): subir una foto de 13,7 MP');
await page.goto(`${BASE}/galeria/`, { waitUntil: 'networkidle' });
(await page.locator('#vacioBoton').isVisible()) ? ok('la galería carga y ofrece subir') : mal('no ofrece subir');

await page.setInputFiles('#selector', { name: 'iphone.jpeg', mimeType: 'image/jpeg',
  buffer: readFileSync('public/foto.jpg') });
await page.waitForSelector('.hoja.abierta', { timeout: 10000 }).catch(() => {});
if (await page.locator('.hoja.abierta').count()) { await page.fill('#nombreInput', 'Safari'); await page.click('#hojaBoton'); }

await page.waitForFunction(() => document.getElementById('progresoTexto')?.textContent?.includes('Gracias'), { timeout: 60000 })
  .then(() => ok('la subida termina')).catch(async () => mal(`no terminó: "${await page.locator('#progresoTexto').textContent()}"`));

const web = firmado?.archivos?.find((a) => a.rol === 'web');
web?.contentType === 'image/jpeg' ? ok('Safari sube JPEG (no sabe generar WebP)') : mal(`formato: ${web?.contentType}`);
completado?.ancho === 2560 ? ok('con el ajuste de JPEG: 2560 px de lado largo') : mal(`ancho: ${completado?.ancho}`);
web && web.size < 1_500_000 ? ok(`y un peso razonable: ${(web.size / 1024).toFixed(0)} KB`) : mal(`peso: ${web?.size}`);

await page.waitForSelector('.tarjeta', { timeout: 20000 })
  .then(() => ok('la foto aparece en la galería sin recargar')).catch(() => mal('no aparece'));

await nav.close();
console.log(`\n${'─'.repeat(52)}`);
console.log(fallos.length ? `❌ ${fallos.length} fallo(s)` : '✅ Safari correcto');
process.exit(fallos.length ? 1 : 0);

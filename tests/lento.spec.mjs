// Subida con un 4G saturado, con bytes que salen de verdad por la red.
//
// Los demás tests interceptan la subida con page.route, así que los bytes
// nunca salen y la limitación de velocidad no se aplica. Aquí hay un receptor
// HTTP real y la subida limitada a 300 kbps. Es el test que habría cazado el
// atasco de la víspera: tres fotos a la vez se repartían el ancho de banda, se
// cortaban por tiempo todas juntas y volvían a empezar desde cero.
import { chromium } from 'playwright';
import http from 'http';
import { readFileSync } from 'fs';

const BASE = 'http://127.0.0.1:4321';
const fallos = [];
const ok = (m) => console.log(`  ✓ ${m}`);
const mal = (m) => { fallos.push(m); console.log(`  ✗ ${m}`); };

const intentos = {};
const receptor = http.createServer((req, res) => {
  const cors = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'PUT, OPTIONS',
    'Access-Control-Allow-Headers': 'content-type', 'Access-Control-Expose-Headers': 'ETag' };
  if (req.method === 'OPTIONS') { res.writeHead(204, cors); return res.end(); }
  intentos[req.url] = (intentos[req.url] ?? 0) + 1;
  req.on('data', () => {});
  req.on('end', () => { res.writeHead(200, { ...cors, ETag: '"e"' }); res.end(); });
}).listen(4401);

const nav = await chromium.launch({ channel: 'chrome' });
const ctx = await nav.newContext({ viewport: { width: 390, height: 844 } });
const page = await ctx.newPage();
page.on('pageerror', (e) => mal(`error JS: ${e.message}`));
// Como Safari: sin WebP, cae a JPEG (lo más pesado)
await page.addInitScript(() => {
  const orig = HTMLCanvasElement.prototype.toDataURL;
  HTMLCanvasElement.prototype.toDataURL = function (t, ...r) {
    return t === 'image/webp' ? 'data:image/png;base64,' : orig.call(this, t, ...r);
  };
});
const cdp = await ctx.newCDPSession(page);
await cdp.send('Network.enable');
await cdp.send('Network.emulateNetworkConditions', {
  offline: false, latency: 150, downloadThroughput: 1_500_000 / 8, uploadThroughput: 300_000 / 8 });

let completadas = 0;
await page.route('**/categorias.json*', (r) => r.fulfill({ status: 200, contentType: 'application/json', body: '{"categorias":[]}' }));
await page.route('**/indice.json*', (r) => r.fulfill({ status: 200, contentType: 'application/json', body: '{"items":[]}' }));
await page.route('**/firmar', (r) => {
  const id = 'l' + Math.random().toString(36).slice(2, 8);
  return r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ id, subidas: [
    { rol: 'thumb', key: `invitados/${id}/thumb.jpg`, url: `http://127.0.0.1:4401/${id}/t` },
    { rol: 'web',   key: `invitados/${id}/web.jpg`,   url: `http://127.0.0.1:4401/${id}/w` }]}) });
});
await page.route('**/completar', (r) => { completadas++; return r.fulfill({ status: 200, contentType: 'application/json', body: '{"ok":true}' }); });

console.log('\nTres fotos de ~1 MB con una subida de 300 kbps');
await page.goto(`${BASE}/galeria/`, { waitUntil: 'networkidle' });
await page.setInputFiles('#selector', [0, 1, 2].map((i) => ({
  name: `f${i}.jpeg`, mimeType: 'image/jpeg', buffer: readFileSync('public/foto3.jpg') })));
if (await page.locator('.hoja.abierta').count()) {
  const campo = page.locator('#nombreInput');
  if (await campo.isVisible()) await campo.fill('Lento');
  await page.click('#hojaBoton');
}

let vioPorcentaje = false, barraAntesDeLaPrimera = false;
const t0 = Date.now();
while (completadas < 3 && Date.now() - t0 < 240_000) {
  await page.waitForTimeout(1500);
  const txt = (await page.locator('#progresoTexto').textContent()) ?? '';
  const barra = parseFloat(await page.locator('#progresoBarra').evaluate((e) => e.style.width) || '0');
  if (/foto \d+: \d+ %/.test(txt)) vioPorcentaje = true;
  if (completadas === 0 && barra > 0) barraAntesDeLaPrimera = true;
}
completadas === 3 ? ok(`las 3 llegan (${((Date.now() - t0) / 1000).toFixed(0)} s)`) : mal(`solo llegaron ${completadas}`);
vioPorcentaje ? ok('el texto enseña el porcentaje de la foto en curso') : mal('no se ve el porcentaje');
barraAntesDeLaPrimera ? ok('la barra se mueve antes de que termine la primera foto') : mal('la barra no se movió hasta acabar una foto');
const reenviados = Object.values(intentos).filter((n) => n > 1).length;
reenviados === 0 ? ok(`ningún archivo se reenvía (${Object.keys(intentos).length} archivos, ${Object.keys(intentos).length} envíos)`) : mal(`${reenviados} archivos reenviados`);

await nav.close();
receptor.close();
console.log(`\n${'─'.repeat(52)}`);
console.log(fallos.length ? `❌ ${fallos.length} fallo(s)` : '✅ Subida lenta correcta');
process.exit(fallos.length ? 1 : 0);

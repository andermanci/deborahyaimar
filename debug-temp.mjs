import { chromium } from 'playwright';
import { readFileSync } from 'fs';
const BASE = 'http://127.0.0.1:4321';
const nav = await chromium.launch({ channel: 'chrome' });
const ctx = await nav.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
const page = await ctx.newPage();
page.on('pageerror', (e) => console.log('  [ERROR]', e.message));

let hayFoto = false;   // el índice empieza VACÍO, como en producción
await page.route('**/indice.json*', (r) => r.fulfill({
  status: 200, contentType: 'application/json',
  body: JSON.stringify({ items: (hayFoto && !r.request().url().includes('oficial')) ? [{
    id: 'nueva', tipo: 'foto', categoria: null, nombre: 'Ensayo', deviceId: 'd',
    thumb: BASE + '/foto2.jpg', web: BASE + '/foto2.jpg', poster: null,
    duracion: null, ancho: 1200, alto: 800, ts: 1,
  }] : [] }),
}));
await page.route('**/firmar', (r) => r.fulfill({ status: 200, contentType: 'application/json',
  body: JSON.stringify({ id: 'n', subidas: [
    { rol: 'thumb', key: 'invitados/n/thumb.webp', url: BASE + '/__put/t' },
    { rol: 'web',   key: 'invitados/n/web.webp',   url: BASE + '/__put/w' }]}) }));
await page.route('**/__put/**', (r) => r.fulfill({ status: 200, headers: { ETag: '"e"' }, body: '' }));
await page.route('**/completar', (r) => { hayFoto = true; return r.fulfill({ status: 200, contentType: 'application/json', body: '{"ok":true}' }); });

await page.goto(BASE + '/galeria/', { waitUntil: 'networkidle' });
console.log('  arranque vacío  → tarjetas:', await page.locator('.tarjeta').count(),
            '| fab visible:', await page.locator('#fab').isVisible());

await page.setInputFiles('#selector', { name: 'x.jpg', mimeType: 'image/jpeg', buffer: readFileSync('public/foto2.jpg') });
await page.fill('#nombreInput', 'Ensayo');
await page.click('#hojaBoton');
await page.waitForFunction(() => document.getElementById('progresoTexto')?.textContent?.includes('Gracias'), { timeout: 60000 });
console.log('  subida ok');

await page.waitForTimeout(1500);
console.log('  sin recargar    → tarjetas:', await page.locator('.tarjeta').count());

await page.reload({ waitUntil: 'networkidle' });
await page.waitForTimeout(3000);
const n = await page.locator('.tarjeta').count();
console.log('  tras recargar   → tarjetas:', n);
if (n === 0) {
  await page.screenshot({ path: '/tmp/fallo.png' });
  console.log('  diagnóstico:', JSON.stringify(await page.evaluate(() => ({
    postBoda: document.getElementById('postBoda')?.hidden,
    columnas: document.querySelectorAll('.columna').length,
    rejilla: getComputedStyle(document.getElementById('rejilla')).display,
    vacio: document.getElementById('vacio')?.classList.contains('visible'),
  }))));
}
await nav.close();

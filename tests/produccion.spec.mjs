import { chromium } from 'playwright';
import { readFileSync } from 'fs';

const SITIO = 'https://deborahyaimar.com';
const fallos = [];
const ok = (m) => console.log(`  ✓ ${m}`);
const mal = (m) => { fallos.push(m); console.log(`  ✗ ${m}`); };

const nav = await chromium.launch({ channel: 'chrome' });
const ctx = await nav.newContext({
  viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true,
  userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
});
const page = await ctx.newPage();
page.on('pageerror', (e) => mal(`error JS: ${e.message}`));

console.log('\n1) Un invitado escanea el QR hoy');
await page.goto(`${SITIO}/fotos`, { waitUntil: 'networkidle' });
page.url().includes('/galeria') ? ok('el QR lleva a la galería') : mal(`fue a ${page.url()}`);
await page.locator('#postBoda').isVisible() ? ok('LA GALERÍA ESTÁ ABIERTA') : mal('sigue cerrada');
await page.locator('#preBoda').isHidden() ? ok('sin cuenta atrás') : mal('sigue la cuenta atrás');
await page.locator('#navSubir').isVisible() ? ok('el botón Subir se ve (y ahora sí lleva a algún sitio)') : mal('el botón Subir sigue oculto');
const tab = await page.locator('.gl-tab.active').getAttribute('data-cat');
tab === 'invitados' ? ok('abre en Invitados') : mal(`abre en ${tab}`);

console.log('\n2) Sube una foto de verdad');
await page.fill('#ufNombre', 'Ensayo Claude');
await page.setInputFiles('#ufFileInput', {
  name: 'boda.jpg', mimeType: 'image/jpeg', buffer: readFileSync('public/foto2.jpg'),
});
await page.click('#ufSubmitBtn');
await page.waitForFunction(
  () => document.getElementById('ufColaTexto')?.textContent?.includes('Gracias'),
  { timeout: 90000 }
).then(() => ok('subida a R2 confirmada por el servidor'))
 .catch(async () => mal(`no completó: "${await page.locator('#ufColaTexto').textContent()}"`));

console.log('\n3) ¿Aparece en la galería?');
await page.waitForTimeout(18000);
await page.reload({ waitUntil: 'networkidle' });
await page.waitForSelector('.gl-item', { timeout: 25000 })
  .then(() => ok('la foto aparece en la rejilla')).catch(() => mal('no aparece'));
const nombre = await page.locator('.gl-item-name').first().textContent().catch(() => '');
nombre === 'Ensayo Claude' ? ok('con el nombre de quien la subió') : mal(`nombre: "${nombre}"`);
const src = await page.locator('.gl-item img').first().getAttribute('src').catch(() => '');
src?.includes('fotos.deborahyaimar.org') ? ok('servida desde fotos.deborahyaimar.org') : mal(`src: ${src}`);

console.log('\n4) Lightbox');
await page.locator('.gl-item').first().click();
await page.waitForSelector('.lightbox.open', { timeout: 8000 })
  .then(() => ok('el lightbox abre')).catch(() => mal('no abre'));
const grande = await page.locator('#lbSlot img').getAttribute('src').catch(() => '');
grande?.includes('/web.') ? ok('muestra la versión grande, no la miniatura') : mal(`lightbox src: ${grande}`);

console.log('\n5) El mural');
const m = await ctx.newPage();
await m.goto(`${SITIO}/mural/`, { waitUntil: 'networkidle' });
await m.waitForTimeout(4000);
(await m.locator('.diapo.activa').count()) === 1 ? ok('el mural proyecta la foto') : mal('el mural no muestra nada');
(await m.locator('#autor').textContent()) === 'Ensayo Claude' ? ok('con el nombre en grande') : mal('sin autor');

await nav.close();
console.log(`\n${'─'.repeat(54)}`);
console.log(fallos.length ? `❌ ${fallos.length} fallo(s)` : '✅ PRODUCCIÓN VERIFICADA DE PUNTA A PUNTA');
process.exit(fallos.length ? 1 : 0);

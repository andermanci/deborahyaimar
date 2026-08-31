import { chromium } from 'playwright';
import { readFileSync } from 'fs';

const SITIO = 'https://deborahyaimar.com';
const fallos = [];
const ok = (m) => console.log(`  ✓ ${m}`);
const mal = (m) => { fallos.push(m); console.log(`  ✗ ${m}`); };

const nav = await chromium.launch({ channel: 'chrome' });
// Simulando un iPhone de invitado
const ctx = await nav.newContext({
  viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true,
  userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
});
const page = await ctx.newPage();
page.on('pageerror', (e) => mal(`error JS: ${e.message}`));

console.log('\n1) Hoy (faltan 12 días): el invitado escanea el QR');
await page.goto(`${SITIO}/fotos`, { waitUntil: 'networkidle' });
page.url().includes('/galeria') ? ok('el QR redirige a la galería') : mal(`fue a ${page.url()}`);
await page.locator('#preBoda').isVisible() ? ok('ve la cuenta atrás') : mal('no ve la cuenta atrás');
await page.locator('#postBoda').isHidden() ? ok('la galería está cerrada') : mal('la galería está abierta antes de tiempo');
const dias = await page.locator('#cdDias').textContent();
ok(`faltan ${dias} días según el contador`);
await page.locator('#navSubir').isHidden() ? ok('el botón Subir está oculto (no lleva a ningún sitio aún)') : mal('el botón Subir se ve');

console.log('\n2) El día de la boda: subida real desde el móvil');
await page.clock.setFixedTime(new Date('2026-09-12T18:30:00+02:00'));
await page.reload({ waitUntil: 'networkidle' });
await page.locator('#postBoda').isVisible() ? ok('la galería se abre sola') : mal('sigue cerrada');
const tab = await page.locator('.gl-tab.active').getAttribute('data-cat');
tab === 'invitados' ? ok('abre en Invitados, no en una pestaña vacía') : mal(`abre en ${tab}`);

await page.fill('#ufNombre', 'Ensayo Claude');
await page.setInputFiles('#ufFileInput', {
  name: 'boda.jpg', mimeType: 'image/jpeg', buffer: readFileSync('public/foto2.jpg'),
});
await page.click('#ufSubmitBtn');
await page.waitForFunction(
  () => document.getElementById('ufColaTexto')?.textContent?.includes('Gracias'),
  { timeout: 90000 }
).then(() => ok('la foto se sube de verdad a R2 y el servidor la confirma'))
 .catch(async () => mal(`no completó: "${await page.locator('#ufColaTexto').textContent()}"`));

console.log('\n3) ¿Aparece en la galería?');
await page.waitForTimeout(18000);
await page.clock.setFixedTime(new Date('2026-09-12T18:31:00+02:00'));
await page.reload({ waitUntil: 'networkidle' });
await page.waitForSelector('.gl-item', { timeout: 20000 })
  .then(() => ok('la foto aparece en la rejilla'))
  .catch(() => mal('la foto no aparece'));
const nombre = await page.locator('.gl-item-name').first().textContent().catch(() => '');
nombre === 'Ensayo Claude' ? ok('con el nombre de quien la subió') : mal(`nombre: "${nombre}"`);
const src = await page.locator('.gl-item img').first().getAttribute('src');
src?.includes('fotos.deborahyaimar.org') ? ok('servida desde fotos.deborahyaimar.org') : mal(`src: ${src}`);

console.log('\n4) El mural');
const m = await ctx.newPage();
await m.goto(`${SITIO}/mural/`, { waitUntil: 'networkidle' });
await m.waitForTimeout(3000);
(await m.locator('.diapo.activa').count()) === 1 ? ok('el mural proyecta la foto') : mal('el mural no muestra nada');
(await m.locator('#autor').textContent()) === 'Ensayo Claude' ? ok('con el nombre en grande') : mal('sin autor');

await nav.close();
console.log(`\n${'─'.repeat(54)}`);
console.log(fallos.length ? `❌ ${fallos.length} fallo(s)` : '✅ ENSAYO GENERAL SUPERADO');
process.exit(fallos.length ? 1 : 0);

import { chromium } from 'playwright';
import { readFileSync } from 'fs';

const SITIO = 'https://deborahyaimar.com';
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
// Lo que importa no es CUÁL de los dos botones, sino que siempre haya uno.
const hayBoton = (await page.locator('#fab').isVisible()) || (await page.locator('#vacioBoton').isVisible());
hayBoton ? ok('siempre hay una forma visible de añadir fotos') : mal('no hay ningún botón para subir');
const tab = await page.locator('.pestana.activa').getAttribute('data-cat');
tab === 'invitados' ? ok('abre en Invitados') : mal(`abre en ${tab}`);

console.log('\n2) Sube una foto de verdad');
await page.fill('#nombreInput', 'Ensayo Claude');
await page.setInputFiles('#selector', {
  name: 'boda.jpg', mimeType: 'image/jpeg', buffer: readFileSync('public/foto2.jpg'),
});
await rellenarNombre(page, 'Ensayo Claude');
await page.waitForFunction(
  () => document.getElementById('progresoTexto')?.textContent?.includes('Gracias'),
  { timeout: 90000 }
).then(() => ok('subida a R2 confirmada por el servidor'))
 .catch(async () => mal(`no completó: "${await page.locator('#progresoTexto').textContent()}"`));

console.log('\n3) ¿Aparece en la galería?');
// El índice se cachea 15 s en el borde. Esperamos a que la API la tenga y
// solo entonces recargamos: así el test mide el render, no la caché.
let enApi = false;
for (let i = 0; i < 30 && !enApi; i++) {
  const r = await fetch('https://api.deborahyaimar.org/indice.json');
  const d = await r.json();
  enApi = (d.items ?? []).some((x) => x.nombre === 'Ensayo Claude');
  if (!enApi) await new Promise((res) => setTimeout(res, 3000));
}
enApi ? ok('la API ya la sirve') : mal('la API no la sirve tras 90 s');
await page.reload({ waitUntil: 'networkidle' });
await page.waitForSelector('.tarjeta', { timeout: 60000 })
  .then(() => ok('la foto aparece en la rejilla'))
  .catch(async () => {
    mal('no aparece');
    await page.screenshot({ path: '/tmp/fallo.png', fullPage: false });
    const diag = await page.evaluate(() => ({
      url: location.href,
      postBodaOculto: document.getElementById('postBoda')?.hidden,
      preBodaOculto: document.getElementById('preBoda')?.hidden,
      tarjetas: document.querySelectorAll('.tarjeta').length,
      columnas: document.querySelectorAll('.columna').length,
      vacio: document.getElementById('vacio')?.classList.contains('visible'),
      progreso: document.getElementById('progresoTexto')?.textContent,
    }));
    console.log('    diagnóstico:', JSON.stringify(diag));
  });
const nombre = await page.locator('.tarjeta-quien').first().textContent().catch(() => '');
nombre === 'Ensayo Claude' ? ok('con el nombre de quien la subió') : mal(`nombre: "${nombre}"`);
const src = await page.locator('.tarjeta img').first().getAttribute('src').catch(() => '');
src?.includes('fotos.deborahyaimar.org') ? ok('servida desde fotos.deborahyaimar.org') : mal(`src: ${src}`);

console.log('\n4) Lightbox');
await page.locator('.tarjeta').first().click();
await page.waitForSelector('.visor.abierto', { timeout: 8000 })
  .then(() => ok('el lightbox abre')).catch(() => mal('no abre'));
const grande = await page.locator('#visorSlot img').getAttribute('src').catch(() => '');
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

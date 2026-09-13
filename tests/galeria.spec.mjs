import { chromium } from 'playwright';
import { readFileSync } from 'fs';

const BASE = 'http://127.0.0.1:4321';
const fallos = [];
const ok = (m) => console.log(`  ✓ ${m}`);
const mal = (m) => { fallos.push(m); console.log(`  ✗ ${m}`); };

/** El nombre se pide una vez, en una hoja, después de elegir los archivos. */
async function rellenarNombre(pg, nombre) {
  const hoja = pg.locator('.hoja.abierta');
  if (!(await hoja.count())) return;
  // El nombre solo se pide la primera vez. A partir de ahí la hoja sigue
  // apareciendo, pero solo para elegir la calidad y confirmar la subida.
  const campo = pg.locator('#nombreInput');
  if (await campo.isVisible()) await campo.fill(nombre);
  await pg.click('#hojaBoton');
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
  { id: 'a1', tipo: 'foto', categoria: null, nombre: '<img src=x onerror=alert(1)>', deviceHash: 'ajena0000000',
    thumb: `${BASE}/foto2.jpg`, web: `${BASE}/foto2.jpg`, poster: null, duracion: null, ancho: 1200, alto: 800, ts: 2 },
  { id: 'a2', tipo: 'video', categoria: null, nombre: 'Marta', deviceHash: 'ajena0000000',
    thumb: `${BASE}/foto3.jpg`, web: `${BASE}/nope.mp4`, poster: `${BASE}/foto3.jpg`, duracion: 12, ancho: 1080, alto: 1920, ts: 1 },
]};

await page.route('**/categorias.json*', (r) => r.fulfill({ status: 200, contentType: 'application/json', body: '{"categorias":[]}' }));
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
const srcAntes = await page.locator('#diapoAct img').getAttribute('src');
// Eventos táctiles reales: el handler escucha touchstart/touchend, no ratón.
await page.evaluate(() => {
  // Los gestos viven en la escena, no en el visor entero: recorrer la tira de
  // miniaturas es igual de horizontal y no debe pasar de foto.
  const lb = document.getElementById('visorEscena');
  const toque = (x) => new Touch({ identifier: 1, target: lb, clientX: x, clientY: 400 });
  lb.dispatchEvent(new TouchEvent('touchstart', { touches: [toque(340)], bubbles: true }));
  lb.dispatchEvent(new TouchEvent('touchend', { changedTouches: [toque(40)], bubbles: true }));
});
// Pasar de foto ahora ANIMA (0,28 s): hay que esperar a que el carril termine,
// no un tiempo fijo que se quede corto.
const hayVideo = await page
  .waitForFunction(() => document.querySelectorAll('#diapoAct video').length === 1, { timeout: 5000 })
  .then(() => true).catch(() => false);
hayVideo ? ok('el swipe avanza a la siguiente (el vídeo)') : mal('el swipe no avanzó');
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
  web.size < 1_200_000 ? ok('web por debajo de 1,2 MB') : mal(`web demasiado grande: ${web.size}`);
  thumb.size < 80_000 ? ok('thumb por debajo de 80 KB') : mal(`thumb demasiado grande: ${thumb.size}`);
  web.contentType === 'image/webp' ? ok('convertida a webp') : mal(`formato ${web.contentType}`);
}
partesRecibidas.length === 2 ? ok('subió exactamente 2 archivos (thumb + web)') : mal(`subió ${partesRecibidas.length}`);
completadoCon?.ancho === 3072 ? ok(`redimensionada a ${completadoCon.ancho}px de lado largo`) : mal(`ancho ${completadoCon?.ancho}`);
completadoCon?.nombre === 'Ander' ? ok('registra el nombre') : mal('no registra el nombre');

// ── 6. Persistencia del nombre ───────────────────────────────────────
console.log('\n6) El nombre no se vuelve a pedir');
await page.reload({ waitUntil: 'networkidle' });
const guardado = await page.evaluate(() => localStorage.getItem('ad-nombre'));
guardado === 'Ander' ? ok('el nombre queda guardado') : mal(`guardó "${guardado}"`);

// La hoja SÍ reaparece (es donde se elige la calidad y se ve el peso), pero
// ya no pregunta quién eres.
firmadoCon = null;
await page.setInputFiles('#selector', { name: 'otra.jpg', mimeType: 'image/jpeg', buffer: readFileSync('public/foto3.jpg') });
await page.waitForTimeout(600);
(await page.locator('.hoja.abierta').count()) === 1
  ? ok('la hoja se abre para confirmar la subida')
  : mal('la hoja no se abrió');
(await page.locator('#nombreInput').isVisible())
  ? mal('volvió a pedir el nombre')
  : ok('no vuelve a pedir el nombre');
(await page.locator('#hojaBoton').textContent()).includes('Subir')
  ? ok('el botón dice qué se va a subir')
  : mal(`el botón dice "${await page.locator('#hojaBoton').textContent()}"`);
await page.click('#hojaBoton');
await page.waitForFunction(() => document.getElementById('progresoTexto')?.textContent?.includes('Gracias'), { timeout: 20000 })
  .then(() => ok('la segunda subida se completa en un solo toque'))
  .catch(() => mal('la segunda subida no completó'));

// ── 7. Borrar mi propia foto ─────────────────────────────────────────
console.log('\n7) Borrar mi propia foto');
let borradoCon = null;
await page.route('**/borrar', async (r) => {
  borradoCon = JSON.parse(r.request().postData());
  await r.fulfill({ status: 200, contentType: 'application/json', body: '{"ok":true}' });
});

// El índice pasa a incluir una foto MÍA: misma huella que calcula el cliente.
const miDevice = await page.evaluate(() => localStorage.getItem('ad-device'));
const miHash = await page.evaluate(async (d) => {
  const h = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`ad-galeria:${d}`));
  return Array.from(new Uint8Array(h)).slice(0, 12).map((b) => b.toString(16).padStart(2, '0')).join('');
}, miDevice);

indice.items = [{ id: 'mia', tipo: 'foto', categoria: null, nombre: 'Ander', deviceHash: miHash,
  thumb: `${BASE}/foto2.jpg`, web: `${BASE}/foto2.jpg`, poster: null, duracion: null,
  ancho: 1200, alto: 800, ts: 9 }];
await page.reload({ waitUntil: 'networkidle' });
await page.waitForSelector('.tarjeta', { timeout: 10000 });

(await page.locator('.tarjeta-mia').count()) === 1 ? ok('la foto propia sale marcada') : mal('no está marcada como propia');
const etiqueta = await page.locator('.tarjeta-quien').first().textContent();
etiqueta?.includes('tuya') ? ok('la etiqueta dice que es tuya') : mal(`etiqueta: ${etiqueta}`);

page.once('dialog', (d) => d.accept());
await page.locator('.tarjeta').first().click();
await page.waitForSelector('.visor.abierto', { timeout: 5000 });
await page.locator('#visorBorrar').isVisible() ? ok('ofrece borrarla') : mal('no ofrece borrarla');
await page.click('#visorBorrar');
await page.waitForTimeout(1200);

borradoCon?.id === 'mia' && borradoCon?.deviceId === miDevice
  ? ok('llama a /borrar con el id y el device correctos')
  : mal(`petición: ${JSON.stringify(borradoCon)}`);
(await page.locator('.tarjeta').count()) === 0 ? ok('desaparece de la pantalla') : mal('sigue en pantalla');

// Y si el servidor la rechaza, NO debe quitarse
console.log('\n8) Si el servidor rechaza el borrado');
indice.items = [{ id: 'ajena', tipo: 'foto', categoria: null, nombre: 'Otro', deviceHash: miHash,
  thumb: `${BASE}/foto2.jpg`, web: `${BASE}/foto2.jpg`, poster: null, duracion: null,
  ancho: 1200, alto: 800, ts: 9 }];
await page.unroute('**/borrar');
await page.route('**/borrar', (r) => r.fulfill({ status: 403, contentType: 'application/json', body: '{"error":"esa foto no es tuya"}' }));
await page.reload({ waitUntil: 'networkidle' });
await page.waitForSelector('.tarjeta', { timeout: 10000 });
page.once('dialog', (d) => d.accept());
await page.locator('.tarjeta').first().click();
await page.waitForSelector('.visor.abierto', { timeout: 5000 });
await page.click('#visorBorrar');
await page.waitForTimeout(1200);
(await page.locator('.tarjeta').count()) === 1 ? ok('la foto SIGUE ahí (no miente)') : mal('la quitó sin permiso del servidor');
(await page.locator('#aviso').textContent())?.includes('No se pudo') ? ok('avisa de que no se pudo') : mal('no avisó del fallo');

// ── 9. La foto aparece sola, sin recargar ────────────────────────────
console.log('\n9) Tras subir, la foto aparece sin recargar');
{
  const p2 = await ctx.newPage();
  p2.on('pageerror', (e) => mal(`error JS: ${e.message}`));

  const urlsIndice = [];
  let hayFoto = false;
  await p2.route('**/categorias.json*', (r) => r.fulfill({ status: 200, contentType: 'application/json', body: '{"categorias":[]}' }));
  await p2.route('**/indice.json*', (r) => {
    const u = r.request().url();
    if (!u.includes('oficial')) urlsIndice.push(u);
    return r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({
      items: (hayFoto && !u.includes('oficial')) ? [{
        id: 'recien', tipo: 'foto', categoria: null, nombre: 'Ander', deviceHash: 'x',
        thumb: `${BASE}/foto2.jpg`, web: `${BASE}/foto2.jpg`, poster: null,
        duracion: null, ancho: 1200, alto: 800, ts: 5,
      }] : [] }) });
  });
  await p2.route('**/firmar', (r) => r.fulfill({ status: 200, contentType: 'application/json',
    body: JSON.stringify({ id: 'n', subidas: [
      { rol: 'thumb', key: 'invitados/n/thumb.webp', url: `${BASE}/__put/t` },
      { rol: 'web',   key: 'invitados/n/web.webp',   url: `${BASE}/__put/w` }]}) }));
  await p2.route('**/__put/**', (r) => r.fulfill({ status: 200, headers: { ETag: '"e"' }, body: '' }));
  await p2.route('**/completar', (r) => { hayFoto = true; return r.fulfill({ status: 200, contentType: 'application/json', body: '{"ok":true}' }); });

  await p2.goto(`${BASE}/galeria/`, { waitUntil: 'networkidle' });
  (await p2.locator('.tarjeta').count()) === 0 ? ok('empieza vacía') : mal('no empieza vacía');

  const cargasIniciales = urlsIndice.length;
  await p2.setInputFiles('#selector', { name: 'n.jpg', mimeType: 'image/jpeg', buffer: readFileSync('public/foto2.jpg') });
  await rellenarNombre(p2, 'Ander');

  // Sin recargar en ningún momento: la tarjeta debe aparecer sola.
  await p2.waitForSelector('.tarjeta', { timeout: 30000 })
    .then(() => ok('la foto aparece sin recargar la página'))
    .catch(() => mal('la foto no apareció'));

  // La petición de después de subir SÍ salta la caché; las del sondeo NO.
  const nuevas = urlsIndice.slice(cargasIniciales);
  nuevas.some((u) => /[?&]t=\d+/.test(u))
    ? ok('la petición posterior a la subida salta la caché del borde')
    : mal('no forzó datos frescos');
  urlsIndice.slice(0, cargasIniciales).every((u) => !/[?&]t=\d+/.test(u))
    ? ok('el sondeo periódico NO la salta (sigue protegiendo el día de la boda)')
    : mal('¡el sondeo lleva cache-buster!');
  await p2.close();
}

// ── 10. Pestañas construidas con las categorías de los novios ────────
console.log('\n10) Las pestañas salen de las categorías reales');
{
  const p3 = await ctx.newPage();
  p3.on('pageerror', (e) => mal(`error JS: ${e.message}`));

  const oficiales = [
    { id:'o1', tipo:'foto', categoria:'baile', nombre:'', deviceHash:'', thumb:`${BASE}/foto2.jpg`,
      web:`${BASE}/foto2.jpg`, poster:null, duracion:null, ancho:1200, alto:800, ts:3 },
    { id:'o2', tipo:'foto', categoria:'photocall', nombre:'', deviceHash:'', thumb:`${BASE}/foto3.jpg`,
      web:`${BASE}/foto3.jpg`, poster:null, duracion:null, ancho:1200, alto:800, ts:2 },
  ];
  await p3.route('**/categorias.json*', (r) => r.fulfill({ status: 200, contentType: 'application/json',
    body: JSON.stringify({ categorias: [
      { slug: 'ceremonia', nombre: 'Ceremonia' },   // sin fotos: no debe salir
      { slug: 'baile', nombre: 'Baile' },
      { slug: 'photocall', nombre: 'Photocall' },
    ] }) }));
  await p3.route('**/indice.json*', (r) => r.fulfill({ status: 200, contentType: 'application/json',
    body: JSON.stringify({ items: r.request().url().includes('oficial') ? oficiales : [] }) }));

  await p3.goto(`${BASE}/galeria/`, { waitUntil: 'networkidle' });
  await p3.waitForSelector('.pestana[data-cat="baile"]', { timeout: 10000 })
    .then(() => ok('crea la pestaña de una categoría nueva')).catch(() => mal('no la crea'));

  const nombres = await p3.locator('.pestana').allTextContents();
  nombres.includes('Photocall') ? ok(`usa el nombre escrito por los novios (${nombres.join(' · ')})`) : mal(`pestañas: ${nombres}`);
  !nombres.includes('Ceremonia') ? ok('NO enseña categorías vacías') : mal('enseña una categoría sin fotos');
  nombres[0] === 'Invitados' ? ok('Invitados sigue la primera') : mal(`primera: ${nombres[0]}`);

  await p3.click('.pestana[data-cat="photocall"]');
  await p3.waitForTimeout(600);
  (await p3.locator('.tarjeta').count()) === 1 ? ok('filtra por esa categoría') : mal('no filtra bien');
  await p3.close();
}

// ── 11. Presupuesto de peticiones (el límite gratuito del Worker) ─────
console.log('\n11) Cuántas peticiones hace un invitado mirando la galería');
{
  const p4 = await ctx.newPage();
  await p4.clock.install();
  const peticiones = [];
  await p4.route('**/categorias.json*', (r) => { peticiones.push('cat'); return r.fulfill({ status: 200, contentType: 'application/json', body: '{"categorias":[]}' }); });
  await p4.route('**/indice.json*', (r) => {
    peticiones.push(r.request().url().includes('oficial') ? 'ofi' : 'inv');
    return r.fulfill({ status: 200, contentType: 'application/json', body: '{"items":[]}' });
  });
  await p4.goto(`${BASE}/galeria/`, { waitUntil: 'networkidle' });
  peticiones.length = 0;

  // 10 minutos mirando la pantalla
  for (let i = 0; i < 20; i++) { await p4.clock.runFor(30_000); await p4.waitForTimeout(40); }
  const porHora = Math.round(peticiones.length * 6);
  const ofi = peticiones.filter((x) => x === 'ofi').length;
  porHora <= 150
    ? ok(`${peticiones.length} peticiones en 10 min → ~${porHora}/hora (antes 480)`)
    : mal(`demasiadas: ${peticiones.length} en 10 min (~${porHora}/hora)`);
  ofi <= 3 ? ok(`el índice del reportaje solo ${ofi} veces en 10 min`) : mal(`reportaje ${ofi} veces`);

  // 10 minutos con la pestaña oculta
  await p4.evaluate(() => {
    Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true });
    document.dispatchEvent(new Event('visibilitychange'));
  });
  peticiones.length = 0;
  for (let i = 0; i < 20; i++) { await p4.clock.runFor(30_000); await p4.waitForTimeout(40); }
  peticiones.length === 0 ? ok('con la pestaña oculta no pregunta nada') : mal(`oculta hizo ${peticiones.length}`);

  // Al volver, se pone al día al momento
  await p4.evaluate(() => {
    Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true });
    document.dispatchEvent(new Event('visibilitychange'));
  });
  await p4.waitForTimeout(400);
  peticiones.includes('inv') ? ok('al volver a la pestaña se actualiza sin esperar') : mal('no se actualizó al volver');
  await p4.close();
}

// ── 12. Peor caso: foto de 13,7 MP de noche, con grano extremo ────────
console.log('\n12) Foto de noche con mucho grano (las de la fiesta)');
{
  const p5 = await ctx.newPage();
  p5.on('pageerror', (e) => mal(`error JS: ${e.message}`));
  let firmado = null, completado = null;
  await p5.route('**/categorias.json*', (r) => r.fulfill({ status: 200, contentType: 'application/json', body: '{"categorias":[]}' }));
  await p5.route('**/indice.json*', (r) => r.fulfill({ status: 200, contentType: 'application/json', body: '{"items":[]}' }));
  await p5.route('**/firmar', async (r) => {
    firmado = JSON.parse(r.request().postData());
    await r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ id: 'g', subidas: [
      { rol: 'thumb', key: 'invitados/g/thumb.webp', url: `${BASE}/__put/t` },
      { rol: 'web',   key: 'invitados/g/web.webp',   url: `${BASE}/__put/w` }]}) });
  });
  await p5.route('**/__put/**', (r) => r.fulfill({ status: 200, headers: { ETag: '"e"' }, body: '' }));
  await p5.route('**/completar', async (r) => { completado = JSON.parse(r.request().postData());
    await r.fulfill({ status: 200, contentType: 'application/json', body: '{"ok":true}' }); });

  await p5.goto(`${BASE}/galeria/`, { waitUntil: 'networkidle' });
  // 4536×3024 (como un móvil de 13,7 MP) con ruido fuerte: lo peor que se comprime.
  await p5.evaluate(async () => {
    const c = document.createElement('canvas'); c.width = 4536; c.height = 3024;
    const g = c.getContext('2d');
    const img = await createImageBitmap(await (await fetch('/foto.jpg')).blob());
    g.drawImage(img, 0, 0, c.width, c.height);
    const d = g.getImageData(0, 0, c.width, c.height);
    for (let i = 0; i < d.data.length; i += 4) {
      const r = (Math.random() - 0.5) * 70;
      d.data[i] += r; d.data[i + 1] += r; d.data[i + 2] += r;
    }
    g.putImageData(d, 0, 0);
    const blob = await new Promise((r) => c.toBlob(r, 'image/jpeg', 0.95));
    const dt = new DataTransfer(); dt.items.add(new File([blob], 'noche.jpg', { type: 'image/jpeg' }));
    const input = document.getElementById('selector'); input.files = dt.files;
    input.dispatchEvent(new Event('change', { bubbles: true }));
  });
  if (await p5.locator('.hoja.abierta').count()) {
  const campo = p5.locator('#nombreInput');
  if (await campo.isVisible()) await campo.fill('Ander');
  await p5.click('#hojaBoton');
}
  await p5.waitForFunction(() => document.getElementById('progresoTexto')?.textContent?.includes('Gracias'), { timeout: 90000 })
    .then(() => ok('la foto con grano se sube sin fallar')).catch(() => mal('falló la foto con grano'));
  const web = firmado?.archivos?.find((a) => a.rol === 'web');
  web && web.size <= 6_000_000
    ? ok(`pesa ${(web.size / 1024 / 1024).toFixed(2)} MB: dentro del tope del servidor (6 MB)`)
    : mal(`peso fuera de tope: ${web?.size}`);
  completado?.ancho ? ok(`se guardó a ${completado.ancho}×${completado.alto}`) : mal('sin dimensiones');
  await p5.close();
}

// ── 13. Calidad original: tres versiones y botón de descarga ─────────
console.log('\n13) Subir en calidad original');
{
  const p6 = await ctx.newPage();
  p6.on('pageerror', (e) => mal(`error JS: ${e.message}`));
  let firmado = null, originalRegistrado = null;
  const puestos = [];
  const subidoAlIndice = [];

  await p6.route('**/categorias.json*', (r) => r.fulfill({ status: 200, contentType: 'application/json', body: '{"categorias":[]}' }));
  await p6.route('**/indice.json*', (r) => r.fulfill({ status: 200, contentType: 'application/json',
    body: JSON.stringify({ items: subidoAlIndice }) }));
  await p6.route('**/firmar', async (r) => {
    firmado = JSON.parse(r.request().postData());
    const subidas = firmado.archivos.map((a) => ({
      rol: a.rol,
      key: `invitados/o/${a.rol}.${a.contentType.split('/')[1]}`,
      url: `${BASE}/__put/${a.rol}`,
    }));
    await r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ id: 'o', subidas }) });
  });
  let completado = null;
  await p6.route('**/completar', (r) => {
    completado = JSON.parse(r.request().postData());
    return r.fulfill({ status: 200, contentType: 'application/json', body: '{"ok":true}' });
  });
  // Si esta ruta no existiera, la petición saldría al API DE VERDAD.
  await p6.route('**/original', async (r) => {
    originalRegistrado = JSON.parse(r.request().postData());
    // A partir de aquí el índice ya tiene la foto, con su original.
    subidoAlIndice.push({
      id: 'o', tipo: 'foto', categoria: null, nombre: 'Ander', deviceHash: 'x',
      thumb: `${BASE}/foto2.jpg`, web: `${BASE}/foto2.jpg`,
      original: `${BASE}/foto3.jpg`, poster: null,
      duracion: null, ancho: 3072, alto: 2048, ts: 9,
    });
    await r.fulfill({ status: 200, contentType: 'application/json', body: '{"ok":true}' });
  });
  // Después de `**/original` a propósito: Playwright prueba las rutas de la
  // última a la primera, y `**/original` casaría también con /__put/original.
  await p6.route('**/__put/**', (r) => {
    puestos.push(r.request().url().split('/').pop());
    return r.fulfill({ status: 200, headers: { ETag: '"e"' }, body: '' });
  });

  await p6.goto(`${BASE}/galeria/`, { waitUntil: 'networkidle' });

  // Una foto de móvil de verdad: 4536×3024 con grano, que pesa mucho más que
  // su versión web. Las fotos de `public/` ya vienen comprimidas para la web y
  // el original se descartaría por no aportar nada.
  await p6.evaluate(async () => {
    const c = document.createElement('canvas'); c.width = 4536; c.height = 3024;
    const g = c.getContext('2d');
    const img = await createImageBitmap(await (await fetch('/foto.jpg')).blob());
    g.drawImage(img, 0, 0, c.width, c.height);
    const d = g.getImageData(0, 0, c.width, c.height);
    for (let i = 0; i < d.data.length; i += 4) {
      const r = (Math.random() - 0.5) * 70;
      d.data[i] += r; d.data[i + 1] += r; d.data[i + 2] += r;
    }
    g.putImageData(d, 0, 0);
    const blob = await new Promise((r) => c.toBlob(r, 'image/jpeg', 0.95));
    const dt = new DataTransfer();
    dt.items.add(new File([blob], 'IMG_0042.jpg', { type: 'image/jpeg' }));
    document.getElementById('selector').files = dt.files;
    document.getElementById('selector').dispatchEvent(new Event('change'));
  });

  await p6.waitForSelector('.hoja.abierta', { timeout: 10000 });
  (await p6.locator('#calidad').isVisible()) ? ok('ofrece elegir la calidad') : mal('no ofrece elegir calidad');
  (await p6.locator('#opcOriginal').getAttribute('aria-checked')) === 'true'
    ? ok('viene marcada la original por defecto')
    : mal('la opción por defecto no es la original');
  const peso = await p6.locator('#pesoOriginal').textContent();
  /\d+\s*MB/.test(peso) ? ok(`avisa del peso antes de subir: "${peso.trim()}"`) : mal(`peso no calculado: "${peso}"`);

  const campo = p6.locator('#nombreInput');
  if (await campo.isVisible()) await campo.fill('Ander');
  await p6.click('#hojaBoton');

  await p6.waitForFunction(() => document.getElementById('progresoTexto')?.textContent?.includes('Gracias'), { timeout: 60000 })
    .then(() => ok('la subida termina bien')).catch(() => mal('no terminó la subida'));

  const roles = (firmado?.archivos ?? []).map((a) => a.rol).sort();
  JSON.stringify(roles) === JSON.stringify(['original', 'thumb', 'web'])
    ? ok('pide firma para las tres versiones')
    : mal(`pidió firma para ${JSON.stringify(roles)}`);

  const orig = firmado?.archivos?.find((a) => a.rol === 'original');
  const web = firmado?.archivos?.find((a) => a.rol === 'web');
  orig && orig.size > web.size
    ? ok(`el original (${(orig.size / 1024 / 1024).toFixed(1)} MB) pesa más que la web (${(web.size / 1024 / 1024).toFixed(1)} MB)`)
    : mal('el original no es mayor que la versión web');

  // El orden importa: si el original fuera antes, un corte de red dejaría la
  // foto sin publicar.
  puestos.indexOf('original') === puestos.length - 1
    ? ok('el original se sube el último, con la foto ya publicada')
    : mal(`orden de subida inesperado: ${puestos.join(' → ')}`);

  originalRegistrado?.key_original === 'invitados/o/original.jpeg'
    ? ok('registra el original en el índice')
    : mal(`no registró el original: ${JSON.stringify(originalRegistrado)}`);

  // La ELECCIÓN se registra aparte de si hay copia: el panel necesita poder
  // distinguir «eligió ligera» de «eligió original y no hubo copia».
  completado?.calidad === 'original'
    ? ok('registra que eligió calidad original')
    : mal(`no registró la elección: ${JSON.stringify(completado?.calidad)}`);

  // Y la galería lo ofrece.
  await p6.waitForSelector('.tarjeta', { timeout: 15000 });
  await p6.click('.tarjeta');
  await p6.waitForSelector('.visor.abierto', { timeout: 5000 });
  (await p6.locator('#visorDescargarTexto').textContent()).includes('original')
    ? ok('el visor ofrece descargar el original')
    : mal('el visor no ofrece el original');

  await p6.close();
}

// ── 14. Modo ligero: solo dos versiones ──────────────────────────────
console.log('\n14) Subir en modo ligero');
{
  const p7 = await ctx.newPage();
  p7.on('pageerror', (e) => mal(`error JS: ${e.message}`));
  let firmado = null;
  let pidioOriginal = false;

  await p7.route('**/categorias.json*', (r) => r.fulfill({ status: 200, contentType: 'application/json', body: '{"categorias":[]}' }));
  await p7.route('**/indice.json*', (r) => r.fulfill({ status: 200, contentType: 'application/json', body: '{"items":[]}' }));
  await p7.route('**/firmar', async (r) => {
    firmado = JSON.parse(r.request().postData());
    const subidas = firmado.archivos.map((a) => ({ rol: a.rol, key: `invitados/l/${a.rol}.webp`, url: `${BASE}/__put/${a.rol}` }));
    await r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ id: 'l', subidas }) });
  });
  let completadoL = null;
  await p7.route('**/completar', (r) => {
    completadoL = JSON.parse(r.request().postData());
    return r.fulfill({ status: 200, contentType: 'application/json', body: '{"ok":true}' });
  });
  await p7.route('**/original', (r) => { pidioOriginal = true; return r.fulfill({ status: 200, contentType: 'application/json', body: '{"ok":true}' }); });
  await p7.route('**/__put/**', (r) => r.fulfill({ status: 200, headers: { ETag: '"e"' }, body: '' }));

  await p7.goto(`${BASE}/galeria/`, { waitUntil: 'networkidle' });
  await p7.evaluate(async () => {
    const c = document.createElement('canvas'); c.width = 4000; c.height = 3000;
    const g = c.getContext('2d');
    const img = await createImageBitmap(await (await fetch('/foto.jpg')).blob());
    g.drawImage(img, 0, 0, c.width, c.height);
    const blob = await new Promise((r) => c.toBlob(r, 'image/jpeg', 0.95));
    const dt = new DataTransfer();
    dt.items.add(new File([blob], 'IMG_0043.jpg', { type: 'image/jpeg' }));
    document.getElementById('selector').files = dt.files;
    document.getElementById('selector').dispatchEvent(new Event('change'));
  });

  await p7.waitForSelector('.hoja.abierta', { timeout: 10000 });
  await p7.click('#opcLigera');
  (await p7.locator('#opcLigera').getAttribute('aria-checked')) === 'true'
    ? ok('se puede cambiar a la versión ligera')
    : mal('no se marcó la opción ligera');

  const campo = p7.locator('#nombreInput');
  if (await campo.isVisible()) await campo.fill('Ander');
  await p7.click('#hojaBoton');
  await p7.waitForFunction(() => document.getElementById('progresoTexto')?.textContent?.includes('Gracias'), { timeout: 60000 })
    .then(() => ok('la subida ligera termina bien')).catch(() => mal('no terminó la subida ligera'));

  const roles = (firmado?.archivos ?? []).map((a) => a.rol).sort();
  JSON.stringify(roles) === JSON.stringify(['thumb', 'web'])
    ? ok('solo sube thumb y web: nada de original')
    : mal(`pidió firma para ${JSON.stringify(roles)}`);
  pidioOriginal ? mal('llamó a /original sin haberlo subido') : ok('no registra ningún original');
  completadoL?.calidad === 'ligera'
    ? ok('registra que eligió la ligera')
    : mal(`no registró la elección: ${JSON.stringify(completadoL?.calidad)}`);

  // La elección se recuerda para la siguiente vez.
  (await p7.evaluate(() => localStorage.getItem('ad-calidad'))) === 'ligera'
    ? ok('recuerda la elección')
    : mal('no recordó la elección');

  await p7.close();
}

// ── 15. Tira de miniaturas del visor ─────────────────────────────────
console.log('\n15) Moverse entre fotos desde el visor');
{
  const muchas = Array.from({ length: 12 }, (_, i) => ({
    id: `t${i}`, tipo: 'foto', categoria: null, nombre: `Invitado ${i}`, deviceHash: 'ajena0000000',
    thumb: `${BASE}/foto2.jpg`, web: `${BASE}/foto3.jpg`, original: null, poster: null,
    duracion: null, ancho: 1200, alto: 800, ts: 100 - i,
  }));

  const p8 = await ctx.newPage();
  p8.on('pageerror', (e) => mal(`error JS: ${e.message}`));
  await p8.route('**/categorias.json*', (r) => r.fulfill({ status: 200, contentType: 'application/json', body: '{"categorias":[]}' }));
  await p8.route('**/indice.json*', (r) => r.fulfill({ status: 200, contentType: 'application/json',
    body: JSON.stringify(r.request().url().includes('oficial') ? { items: [] } : { items: muchas }) }));
  await p8.goto(`${BASE}/galeria/`, { waitUntil: 'networkidle' });
  await p8.waitForSelector('.tarjeta');

  await p8.locator('.tarjeta').first().click();
  await p8.waitForSelector('.visor.abierto');

  (await p8.locator('.tira-item').count()) === 12
    ? ok('la tira lista las 12 fotos')
    : mal(`la tira tiene ${await p8.locator('.tira-item').count()} miniaturas`);
  (await p8.locator('#visorPos').textContent())?.trim() === '1 / 12'
    ? ok('dice en qué foto estás')
    : mal(`el contador dice "${await p8.locator('#visorPos').textContent()}"`);

  // Las miniaturas son las MISMAS que las de la rejilla: si cambiaran, la tira
  // costaría una descarga por foto en vez de salir del caché.
  const enTira = await p8.locator('.tira-item img').first().getAttribute('src');
  const enRejilla = await p8.locator('.tarjeta img').first().getAttribute('src');
  enTira === enRejilla ? ok('reutiliza las miniaturas ya descargadas') : mal('la tira usa otras imágenes');

  // Saltar a una foto lejana de un toque.
  await p8.locator('.tira-item').nth(7).click();
  await p8.waitForTimeout(400);
  (await p8.locator('#visorPos').textContent())?.trim() === '8 / 12'
    ? ok('tocar una miniatura salta a esa foto')
    : mal(`saltó a "${await p8.locator('#visorPos').textContent()}"`);
  (await p8.locator('.tira-item').nth(7).getAttribute('class'))?.includes('activa')
    ? ok('la miniatura activa queda marcada')
    : mal('no marcó la miniatura activa');

  // Y al pasar de foto con el teclado, la tira sigue.
  await p8.keyboard.press('ArrowRight');
  await p8.waitForTimeout(400);
  (await p8.locator('#visorPos').textContent())?.trim() === '9 / 12'
    ? ok('las flechas siguen pasando de foto')
    : mal(`tras la flecha: "${await p8.locator('#visorPos').textContent()}"`);
  (await p8.locator('.tira-item').nth(8).getAttribute('class'))?.includes('activa')
    ? ok('la tira acompaña al cambio de foto')
    : mal('la tira se quedó atrás');

  // La foto no puede desbordar y taparlo todo: fue el fallo del primer intento.
  const encaja = await p8.evaluate(() => {
    const img = document.querySelector('#diapoAct img');
    const tira = document.getElementById('visorTira');
    if (!img || !tira) return false;
    return img.getBoundingClientRect().bottom <= tira.getBoundingClientRect().top + 1;
  });
  encaja ? ok('la foto no invade la tira') : mal('la foto desborda por debajo y tapa la tira');

  await p8.close();
}

// ── 16. Con una sola foto no hay nada entre lo que moverse ───────────
console.log('\n16) Una sola foto: sin tira ni contador');
{
  const una = [{
    id: 'sola', tipo: 'foto', categoria: null, nombre: 'Ander', deviceHash: 'ajena0000000',
    thumb: `${BASE}/foto2.jpg`, web: `${BASE}/foto3.jpg`, original: null, poster: null,
    duracion: null, ancho: 1200, alto: 800, ts: 1,
  }];
  const p9 = await ctx.newPage();
  p9.on('pageerror', (e) => mal(`error JS: ${e.message}`));
  await p9.route('**/categorias.json*', (r) => r.fulfill({ status: 200, contentType: 'application/json', body: '{"categorias":[]}' }));
  await p9.route('**/indice.json*', (r) => r.fulfill({ status: 200, contentType: 'application/json',
    body: JSON.stringify(r.request().url().includes('oficial') ? { items: [] } : { items: una }) }));
  await p9.goto(`${BASE}/galeria/`, { waitUntil: 'networkidle' });
  await p9.waitForSelector('.tarjeta');
  await p9.locator('.tarjeta').first().click();
  await p9.waitForSelector('.visor.abierto');

  (await p9.locator('#visorTira').isHidden()) ? ok('no enseña la tira') : mal('enseña una tira de una sola foto');
  (await p9.locator('#visorPos').textContent())?.trim() === '' ? ok('no enseña «1 / 1»') : mal('enseña un contador inútil');
  await p9.close();
}

// ── 17. Gesto de pasar foto, y el botón de cerrar ────────────────────
console.log('\n17) Deslizar entre fotos');
{
  // Fotos VERTICALES: llenan la escena de arriba abajo y llegan a la esquina
  // donde vive el botón de cerrar. Es el caso que lo dejó tapado.
  const verticales = Array.from({ length: 8 }, (_, i) => ({
    id: `v${i}`, tipo: 'foto', categoria: null, nombre: `Invitado ${i}`, deviceHash: 'ajena0000000',
    thumb: `${BASE}/foto2.jpg`, web: `${BASE}/foto3.jpg`, original: null, poster: null,
    duracion: null, ancho: 800, alto: 1200, ts: 100 - i,
  }));

  const pA = await ctx.newPage();
  pA.on('pageerror', (e) => mal(`error JS: ${e.message}`));
  await pA.route('**/categorias.json*', (r) => r.fulfill({ status: 200, contentType: 'application/json', body: '{"categorias":[]}' }));
  await pA.route('**/indice.json*', (r) => r.fulfill({ status: 200, contentType: 'application/json',
    body: JSON.stringify(r.request().url().includes('oficial') ? { items: [] } : { items: verticales }) }));
  await pA.goto(`${BASE}/galeria/`, { waitUntil: 'networkidle' });
  await pA.waitForSelector('.tarjeta');
  await pA.locator('.tarjeta').nth(2).click();
  await pA.waitForSelector('.visor.abierto');
  await pA.waitForTimeout(700);

  // El fallo: la escena es un elemento posicionado y va después en el DOM, así
  // que sin z-index la foto se pinta ENCIMA del botón de cerrar.
  const recibe = await pA.evaluate(() => {
    const b = document.getElementById('visorCerrar').getBoundingClientRect();
    const encima = document.elementFromPoint(b.left + b.width / 2, b.top + b.height / 2);
    return Boolean(encima?.closest('#visorCerrar'));
  });
  recibe ? ok('el botón de cerrar recibe el toque sobre una foto vertical') : mal('la foto tapa el botón de cerrar');

  const caja = await pA.locator('#visorEscena').boundingBox();
  const cy = caja.y + caja.height / 2;
  const cdp = await pA.context().newCDPSession(pA);
  const arrastrar = async (desde, hasta, y = cy, soltar = true) => {
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: desde, y: cy }] });
    const pasos = 6;
    for (let k = 1; k <= pasos; k++) {
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [
        { x: Math.round(desde + ((hasta - desde) * k) / pasos), y: Math.round(cy + ((y - cy) * k) / pasos) } ] });
      await pA.waitForTimeout(25);
    }
    if (soltar) { await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] }); await pA.waitForTimeout(700); }
  };
  const pos = async () => (await pA.locator('#visorPos').textContent())?.trim();
  const desplazamiento = async () => pA.evaluate(() =>
    Math.round(new DOMMatrix(getComputedStyle(document.getElementById('visorTren')).transform).m41));

  const reposo = await desplazamiento();
  const antes = await pos();

  // A media arrastre la foto de al lado ya tiene que verse: es el efecto.
  await arrastrar(320, 140, cy, false);
  const enGesto = await desplazamiento();
  enGesto < reposo - 100
    ? ok('el carril sigue al dedo (la foto de al lado ya asoma)')
    : mal(`el carril no se movió: ${reposo} → ${enGesto}`);
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await pA.waitForTimeout(700);

  (await pos()) !== antes ? ok(`al soltar pasa de foto (${antes} → ${await pos()})`) : mal('no pasó de foto');
  (await desplazamiento()) === reposo
    ? ok('y el carril queda cuadrado para el siguiente gesto')
    : mal(`carril descuadrado: ${await desplazamiento()} en vez de ${reposo}`);

  await arrastrar(80, 300);
  (await pos()) === antes ? ok('hacia el otro lado vuelve a la anterior') : mal(`volvió a "${await pos()}"`);

  // Un arrastre corto no puede pasar de foto ni dejar el carril torcido.
  await arrastrar(200, 168);
  (await pos()) === antes && (await desplazamiento()) === reposo
    ? ok('un arrastre corto vuelve a su sitio sin cambiar de foto')
    : mal(`arrastre corto: "${await pos()}", carril ${await desplazamiento()}`);

  // El visor no puede cerrarse al soltar un arrastre.
  (await pA.locator('.visor.abierto').count()) === 1 ? ok('deslizar no cierra el visor') : mal('el visor se cerró al deslizar');

  // Vertical sí cierra, como antes.
  await arrastrar(195, 195, cy + 200);
  (await pA.locator('.visor.abierto').count()) === 0 ? ok('deslizar hacia abajo sigue cerrando') : mal('no cierra al deslizar abajo');
  await pA.close();
}

// ── 18. Nada invisible se traga los clics de la rejilla ──────────────
// En escritorio la hoja de subida se esconde con opacity:0, y un elemento
// transparente SIGUE recibiendo clics: era un rectángulo invisible de 420 px en
// mitad de la pantalla que se comía los clics de las fotos de detrás, sin
// cambiar siquiera el cursor. Se barre la rejilla punto a punto.
console.log('\n18) La rejilla responde en toda su superficie');
{
  const fotos = Array.from({ length: 60 }, (_, i) => ({
    id: `z${i}`, tipo: 'foto', categoria: null, nombre: `Inv ${i}`, deviceHash: 'ajena0000000',
    thumb: `${BASE}/foto2.jpg`, web: `${BASE}/foto3.jpg`, original: null, poster: null,
    duracion: null, ancho: [800, 1200, 900][i % 3], alto: [1200, 800, 900][i % 3], ts: 100000 - i,
  }));

  // Escritorio: es donde la hoja se esconde con opacity en vez de apartarse.
  const ancho = await navegador.newContext({ viewport: { width: 1280, height: 900 } });
  const pC = await ancho.newPage();
  pC.on('pageerror', (e) => mal(`error JS: ${e.message}`));
  await pC.route('**/categorias.json*', (r) => r.fulfill({ status: 200, contentType: 'application/json', body: '{"categorias":[]}' }));
  await pC.route('**/indice.json*', (r) => r.fulfill({ status: 200, contentType: 'application/json',
    body: JSON.stringify(r.request().url().includes('oficial') ? { items: [] } : { items: fotos }) }));
  await pC.goto(`${BASE}/galeria/`, { waitUntil: 'networkidle' });
  await pC.waitForSelector('.tarjeta');
  await pC.waitForTimeout(900);

  const culpables = await pC.evaluate(() => {
    const cuenta = {};
    for (const c of document.querySelectorAll('.tarjeta')) {
      const b = c.getBoundingClientRect();
      if (b.bottom <= 0 || b.top >= innerHeight || b.height < 2) continue;
      for (let fx = 0.15; fx <= 0.85; fx += 0.175) {
        for (let fy = 0.15; fy <= 0.85; fy += 0.175) {
          const y = b.top + b.height * fy;
          if (y < 1 || y > innerHeight - 1) continue;
          const e = document.elementFromPoint(b.left + b.width * fx, y);
          if (e?.closest('.tarjeta') === c) continue;
          // El botón de añadir fotos SÍ debe flotar por encima: es visible.
          if (e?.closest('#fab')) continue;
          const k = e ? `${e.tagName}.${(e.className || '').toString().split(' ')[0]}` : 'nada';
          cuenta[k] = (cuenta[k] || 0) + 1;
        }
      }
    }
    return cuenta;
  });
  Object.keys(culpables).length === 0
    ? ok('ninguna zona muerta en la rejilla')
    : mal(`hay algo invisible encima: ${JSON.stringify(culpables)}`);

  // Y la hoja tiene que seguir siendo clicable cuando se abre de verdad.
  await pC.setInputFiles('#selector', { name: 'x.jpg', mimeType: 'image/jpeg', buffer: readFileSync('public/foto2.jpg') });
  await pC.waitForSelector('.hoja.abierta');
  await pC.waitForTimeout(500);
  const responde = await pC.evaluate(() => {
    const b = document.getElementById('hojaBoton').getBoundingClientRect();
    return Boolean(document.elementFromPoint(b.left + b.width / 2, b.top + b.height / 2)?.closest('#hojaBoton'));
  });
  responde ? ok('y abierta sigue respondiendo al clic') : mal('la hoja abierta no recibe clics');
  await ancho.close();
}

// ── 19. Cuando no se puede llegar al índice, no mentir ───────────────
// El bloqueo de IP de las operadoras deja la página en pie (está en Netlify)
// pero tumba el índice y las fotos (están en Cloudflare). Sin esto, la galería
// enseñaba «Empieza tú. Todavía no hay ninguna foto» con 142 fotos guardadas:
// mentira, y encima da a entender que se han borrado.
console.log('\n19) No se puede llegar al índice');
{
  const pB = await ctx.newPage();
  pB.on('pageerror', (e) => mal(`error JS: ${e.message}`));

  // Así se comporta un bloqueo de verdad: la conexión ni se rechaza ni
  // responde, se queda colgada. Y se cuelga TODO lo que va a ese dominio,
  // también las categorías: con el mock de categorías respondiendo bien, esta
  // prueba pasaba y en producción la galería se quedaba en «Un momento…» para
  // siempre, porque esa petición no llevaba plazo y bloqueaba el pintado.
  let colgado = true;
  await pB.route('**/categorias.json*', (r) => {
    if (colgado) return new Promise(() => {});
    return r.fulfill({ status: 200, contentType: 'application/json', body: '{"categorias":[]}' });
  });
  const fotos = [{
    id: 'b1', tipo: 'foto', categoria: null, nombre: 'Ana', deviceHash: 'ajena0000000',
    thumb: `${BASE}/foto2.jpg`, web: `${BASE}/foto2.jpg`, original: null, poster: null,
    duracion: null, ancho: 1200, alto: 800, ts: 5,
  }];
  await pB.route('**/indice.json*', (r) => {
    if (colgado) return new Promise(() => {});   // nunca resuelve
    return r.fulfill({ status: 200, contentType: 'application/json',
      body: JSON.stringify(r.request().url().includes('oficial') ? { items: [] } : { items: fotos }) });
  });

  await pB.goto(`${BASE}/galeria/`, { waitUntil: 'domcontentloaded' });

  // Mientras no se sabe, no se afirma nada: ni que hay fotos ni que no las hay.
  await pB.waitForTimeout(700);
  const pronto = (await pB.locator('#vacioTitulo').textContent())?.trim();
  pronto === 'Un momento…'
    ? ok('mientras se espera no dice que no haya fotos')
    : mal(`nada más entrar dice «${pronto}»`);

  // Y cuando la petición se rinde, lo cuenta. El plazo son 8 s y las peticiones
  // van en paralelo: si alguien las volviera a poner en serie, o le quitara el
  // plazo a alguna, esto se pasaría de 14 s y fallaría.
  const t0 = Date.now();
  await pB.waitForFunction(
    () => document.getElementById('vacioTitulo')?.textContent?.includes('fútbol'),
    { timeout: 14000 },
  ).then(() => ok(`al rendirse explica el bloqueo (${((Date.now() - t0) / 1000).toFixed(1)} s)`))
   .catch(() => mal('se quedó colgada en «Un momento…»: alguna petición no lleva plazo'));

  const texto = (await pB.locator('#vacioTexto').textContent()) ?? '';
  texto.includes('a salvo') ? ok('y tranquiliza: las fotos están a salvo') : mal(`texto: "${texto.slice(0, 60)}"`);
  !texto.includes('Todavía no hay ninguna foto') ? ok('no dice que la galería esté vacía') : mal('sigue diciendo que no hay fotos');

  // Subir tampoco funcionaría: sale por el mismo sitio que no responde.
  (await pB.locator('#fab').isHidden()) ? ok('no ofrece el botón de subir') : mal('ofrece subir hacia un servidor que no responde');
  (await pB.locator('#vacioBoton').textContent())?.trim() === 'Reintentar'
    ? ok('ofrece reintentar')
    : mal(`el botón dice «${(await pB.locator('#vacioBoton').textContent())?.trim()}»`);

  // Y se recupera sola en cuanto vuelve, sin recargar.
  colgado = false;
  await pB.click('#vacioBoton');
  await pB.waitForSelector('.tarjeta', { timeout: 20000 })
    .then(() => ok('al volver el servicio, la galería se recupera sin recargar'))
    .catch(() => mal('no se recuperó'));
  (await pB.locator('.vacio.visible').count()) === 0 ? ok('y el mensaje desaparece') : mal('el mensaje se queda puesto');
  await pB.close();
}

// ── 20. Sin conexión es otra cosa, y se dice distinto ────────────────
console.log('\n20) Sin conexión');
{
  const pD = await ctx.newPage();
  pD.on('pageerror', (e) => mal(`error JS: ${e.message}`));
  await pD.addInitScript(() => Object.defineProperty(navigator, 'onLine', { get: () => false }));
  await pD.route('**/categorias.json*', (r) => r.abort('internetdisconnected'));
  await pD.route('**/indice.json*', (r) => r.abort('internetdisconnected'));
  await pD.goto(`${BASE}/galeria/`, { waitUntil: 'domcontentloaded' });

  await pD.waitForFunction(
    () => document.getElementById('vacioTitulo')?.textContent === 'Sin conexión', { timeout: 15000 },
  ).then(() => ok('dice que no hay conexión, no que sea el fútbol')).catch(() => mal('no distinguió el caso sin conexión'));
  (await pD.locator('#vacioTexto').textContent())?.includes('siguen todas')
    ? ok('y también tranquiliza')
    : mal('el texto no tranquiliza');
  await pD.close();
}

// ── 21. Una galería vacía DE VERDAD sigue diciendo lo de siempre ─────
console.log('\n21) Vacía de verdad');
{
  const pE = await ctx.newPage();
  pE.on('pageerror', (e) => mal(`error JS: ${e.message}`));
  await pE.route('**/categorias.json*', (r) => r.fulfill({ status: 200, contentType: 'application/json', body: '{"categorias":[]}' }));
  await pE.route('**/indice.json*', (r) => r.fulfill({ status: 200, contentType: 'application/json', body: '{"items":[]}' }));
  await pE.goto(`${BASE}/galeria/`, { waitUntil: 'networkidle' });
  await pE.waitForTimeout(600);

  (await pE.locator('#vacioTitulo').textContent())?.trim() === 'Empieza tú'
    ? ok('el índice vacío sigue invitando a subir la primera')
    : mal(`dice «${(await pE.locator('#vacioTitulo').textContent())?.trim()}»`);
  (await pE.locator('#vacioBoton').textContent())?.trim() === 'Añadir mis fotos'
    ? ok('y el botón vuelve a ser el de subir')
    : mal('el botón se quedó en «Reintentar»');
  await pE.close();
}

await navegador.close();
console.log(`\n${'─'.repeat(50)}`);
console.log(fallos.length ? `❌ ${fallos.length} fallo(s)` : '✅ Todo correcto');
process.exit(fallos.length ? 1 : 0);

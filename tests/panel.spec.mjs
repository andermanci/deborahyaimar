import { chromium } from 'playwright';

const BASE = 'http://127.0.0.1:4321';
const PANEL = `${BASE}/admin-68895abc/`;
const CLAVE = 'clave-de-prueba';
const fallos = [];
const ok = (m) => console.log(`  ✓ ${m}`);
const mal = (m) => { fallos.push(m); console.log(`  ✗ ${m}`); };

const foto = (id, extra = {}) => ({
  id, tipo: 'foto', origen: 'invitado', categoria: null, nombre: 'María',
  oculta: false, thumb: `${BASE}/foto2.jpg`, web: `${BASE}/foto2.jpg`, poster: null,
  duracion: null, ancho: 1200, alto: 800, ts: 1000, ...extra,
});

let datos = [];
const peticiones = [];

const nav = await chromium.launch({ channel: 'chrome' });
const ctx = await nav.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });

async function nuevaPagina() {
  const page = await ctx.newPage();
  page.on('pageerror', (e) => mal(`error JS: ${e.message}`));
  await page.route('**/admin/**', async (r) => {
    const req = r.request();
    const clave = req.headers()['x-admin-password'];
    if (clave !== CLAVE) {
      return r.fulfill({ status: 401, contentType: 'application/json', body: '{"error":"no autorizado"}' });
    }
    const url = new URL(req.url());
    peticiones.push({ ruta: url.pathname, cuerpo: req.postData() ? JSON.parse(req.postData()) : null });

    if (url.pathname === '/admin/login')  return r.fulfill({ status: 200, contentType: 'application/json', body: '{"ok":true}' });
    if (url.pathname === '/admin/media')  return r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ items: datos, total: datos.length }) });
    if (url.pathname === '/admin/stats')  return r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({
      total: 4, visibles: 3, ocultas: 1, fotos: 2, videos: 1, invitados: 3, oficiales: 0, personas: 2,
      ranking: [{ nombre: 'María', n: 2 }, { nombre: 'Jon', n: 1 }],
      porHora: [{ hora: '19', n: 1 }, { hora: '20', n: 2 }],
      almacenamiento: { bytes: 2 * 1024 ** 3, objetos: 8, limiteBytes: 10 * 1024 ** 3 },
    }) });
    return r.fulfill({ status: 200, contentType: 'application/json', body: '{"ok":true}' });
  });
  return page;
}

// ══ 1. Sin contraseña no se ve nada ══════════════════════════════════
console.log('\n1) Acceso');
{
  const page = await nuevaPagina();
  datos = [foto('a'), foto('b')];
  await page.goto(PANEL, { waitUntil: 'networkidle' });
  (await page.locator('#panel').isHidden()) ? ok('sin entrar, el panel está oculto') : mal('el panel se ve sin contraseña');
  (await page.locator('.celda').count()) === 0 ? ok('no se ve ninguna foto') : mal('¡se ven fotos sin contraseña!');

  await page.fill('#clave', 'incorrecta');
  await page.click('#entrar');
  await page.waitForTimeout(900);
  const err = await page.locator('#accesoError').textContent();
  err?.includes('incorrecta') ? ok('contraseña incorrecta → mensaje claro') : mal(`mensaje: "${err}"`);
  (await page.locator('.celda').count()) === 0 ? ok('sigue sin mostrar fotos') : mal('mostró fotos con clave mala');

  await page.fill('#clave', CLAVE);
  await page.click('#entrar');
  await page.waitForSelector('.celda', { timeout: 8000 });
  ok('con la contraseña correcta entra');
  await page.close();
}

// ══ 2. Ve las ocultas ════════════════════════════════════════════════
console.log('\n2) Papelera: ver y restaurar lo oculto');
{
  const page = await nuevaPagina();
  datos = [foto('v1'), foto('o1', { oculta: true, nombre: 'Jon' }), foto('o2', { oculta: true, nombre: 'Jon' })];
  await page.goto(PANEL, { waitUntil: 'networkidle' });
  await page.fill('#clave', CLAVE); await page.click('#entrar');
  await page.waitForSelector('.celda', { timeout: 8000 });

  (await page.locator('.celda').count()) === 1 ? ok('en Invitados solo salen las visibles') : mal('mezcla ocultas con visibles');
  (await page.locator('#cPap').textContent()) === '2' ? ok('la papelera cuenta 2') : mal('la cuenta de papelera falla');

  await page.click('.seccion[data-vista="papelera"]');
  await page.waitForTimeout(400);
  (await page.locator('.celda.oculta').count()) === 2 ? ok('la papelera MUESTRA las ocultas (el agujero del panel viejo)') : mal('no muestra las ocultas');

  await page.click('#btnSeleccion');
  await page.waitForTimeout(200);
  await page.locator('.celda').first().click();
  await page.locator('.celda').nth(1).click();
  (await page.locator('#btnRestaurar').isVisible()) ? ok('en la papelera ofrece Restaurar') : mal('no ofrece restaurar');
  (await page.locator('#btnOcultar').isHidden()) ? ok('y NO ofrece «Ocultar» (ya lo están)') : mal('ofrece ocultar en la papelera');

  peticiones.length = 0;
  await page.click('#btnRestaurar');
  await page.waitForTimeout(900);
  const p = peticiones.find((x) => x.ruta === '/admin/ocultar');
  p?.cuerpo?.ids?.length === 2 && p.cuerpo.oculta === false
    ? ok('restaura las 2 en UNA sola petición')
    : mal(`petición: ${JSON.stringify(p)}`);
  await page.close();
}

// ══ 3. Borrado definitivo ════════════════════════════════════════════
console.log('\n3) Borrado definitivo');
{
  const page = await nuevaPagina();
  datos = [foto('vis'), foto('pap', { oculta: true })];
  await page.goto(PANEL, { waitUntil: 'networkidle' });
  await page.fill('#clave', CLAVE); await page.click('#entrar');
  await page.waitForSelector('.celda', { timeout: 8000 });

  await page.click('#btnSeleccion');
  await page.locator('.celda').first().click();
  (await page.locator('#btnEliminar').isHidden())
    ? ok('fuera de la papelera NO se puede borrar definitivamente')
    : mal('¡se puede borrar definitivamente desde Invitados!');

  await page.click('.seccion[data-vista="papelera"]');
  await page.click('#btnSeleccion');
  await page.locator('.celda').first().click();
  (await page.locator('#btnEliminar').isVisible()) ? ok('en la papelera sí aparece') : mal('no aparece en la papelera');

  // Cancelar el diálogo NO debe borrar
  peticiones.length = 0;
  page.once('dialog', (d) => d.dismiss());
  await page.click('#btnEliminar');
  await page.waitForTimeout(700);
  peticiones.some((x) => x.ruta === '/admin/eliminar')
    ? mal('¡borró aunque se canceló la confirmación!')
    : ok('si cancelas la confirmación, no borra');

  page.once('dialog', async (d) => {
    d.message().includes('PARA SIEMPRE') ? ok('la confirmación avisa de que es irreversible') : mal('confirmación floja');
    await d.accept();
  });
  await page.click('#btnEliminar');
  await page.waitForTimeout(900);
  peticiones.find((x) => x.ruta === '/admin/eliminar')?.cuerpo?.ids?.length === 1
    ? ok('al confirmar, borra')
    : mal('no llamó a /admin/eliminar');
  await page.close();
}

// ══ 4. Filtros ═══════════════════════════════════════════════════════
console.log('\n4) Filtros');
{
  const page = await nuevaPagina();
  datos = [
    foto('f1', { nombre: 'María' }),
    foto('f2', { nombre: 'Jon' }),
    foto('f3', { nombre: 'Jon', tipo: 'video', duracion: 10, poster: `${BASE}/foto3.jpg` }),
  ];
  await page.goto(PANEL, { waitUntil: 'networkidle' });
  await page.fill('#clave', CLAVE); await page.click('#entrar');
  await page.waitForSelector('.celda', { timeout: 8000 });

  await page.selectOption('#fQuien', 'Jon');
  await page.waitForTimeout(300);
  (await page.locator('.celda').count()) === 2 ? ok('filtra por invitado') : mal('el filtro por invitado falla');

  await page.selectOption('#fTipo', 'video');
  await page.waitForTimeout(300);
  (await page.locator('.celda').count()) === 1 ? ok('filtra por tipo') : mal('el filtro por tipo falla');
  await page.close();
}

// ══ 5. Estadísticas ══════════════════════════════════════════════════
console.log('\n5) Resumen');
{
  const page = await nuevaPagina();
  datos = [foto('s1')];
  await page.goto(PANEL, { waitUntil: 'networkidle' });
  await page.fill('#clave', CLAVE); await page.click('#entrar');
  await page.waitForSelector('.celda', { timeout: 8000 });

  await page.click('.seccion[data-vista="stats"]');
  await page.waitForTimeout(700);
  (await page.locator('.tarjeta-dato').count()) === 6 ? ok('pinta las tarjetas de datos') : mal('faltan tarjetas');
  (await page.locator('.fila-rank').count()) === 2 ? ok('pinta el ranking de quién subió más') : mal('no pinta el ranking');
  (await page.locator('.hora-col').count()) === 2 ? ok('pinta el reparto por horas') : mal('no pinta las horas');
  const med = await page.locator('#medidorTxt').textContent();
  med?.includes('2.00 GB de 10 GB') ? ok(`muestra el espacio: "${med.slice(0, 42)}…"`) : mal(`medidor: ${med}`);
  await page.close();
}

// ══ 6. Subida del reportaje ══════════════════════════════════════════
console.log('\n6) Subir el reportaje oficial');
{
  const page = await nuevaPagina();
  datos = [];
  let firmadoCon = null, completadoCon = null, claveFirmar = null;
  await page.route('**/firmar', async (r) => {
    claveFirmar = r.request().headers()['x-admin-password'];
    firmadoCon = JSON.parse(r.request().postData());
    await r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ id: 'of', subidas: [
      { rol: 'thumb', key: 'oficial/of/thumb.webp', url: `${BASE}/__put/t` },
      { rol: 'web',   key: 'oficial/of/web.webp',   url: `${BASE}/__put/w` }]}) });
  });
  await page.route('**/__put/**', (r) => r.fulfill({ status: 200, headers: { ETag: '"e"' }, body: '' }));
  await page.route('**/completar', async (r) => {
    completadoCon = JSON.parse(r.request().postData());
    await r.fulfill({ status: 200, contentType: 'application/json', body: '{"ok":true}' });
  });

  await page.goto(PANEL, { waitUntil: 'networkidle' });
  await page.fill('#clave', CLAVE); await page.click('#entrar');
  await page.waitForTimeout(700);
  await page.click('.seccion[data-vista="subir"]');
  await page.selectOption('#catSubida', 'baile');

  const { readFileSync } = await import('fs');
  await page.setInputFiles('#ficheros', { name: 'r.jpg', mimeType: 'image/jpeg', buffer: readFileSync('public/foto2.jpg') });
  await page.waitForFunction(() => document.getElementById('progresoTxt')?.textContent?.includes('Listo'), { timeout: 60000 })
    .then(() => ok('la subida del reportaje se completa')).catch(() => mal('no completó'));

  firmadoCon?.origen === 'oficial' ? ok('pide firma con origen oficial') : mal(`origen: ${firmadoCon?.origen}`);
  claveFirmar === CLAVE ? ok('manda la contraseña al firmar') : mal('no manda la contraseña');
  completadoCon?.origen === 'oficial' && completadoCon?.categoria === 'baile'
    ? ok('registra origen y categoría («baile»)')
    : mal(`completar: ${JSON.stringify({ o: completadoCon?.origen, c: completadoCon?.categoria })}`);
  await page.close();
}

// ══ 7. Descarga ══════════════════════════════════════════════════════
console.log('\n7) Descargar el álbum');
{
  const page = await nuevaPagina();
  datos = [foto('d1'), foto('d2'), foto('d3', { oculta: true })];
  await page.goto(PANEL, { waitUntil: 'networkidle' });
  await page.fill('#clave', CLAVE); await page.click('#entrar');
  await page.waitForSelector('.celda', { timeout: 8000 });

  await page.click('.seccion[data-vista="descargar"]');
  await page.waitForTimeout(400);
  const resumen = await page.locator('#descResumen').textContent();
  resumen?.startsWith('2 archivos') ? ok('cuenta solo las visibles (la papelera no se descarga)') : mal(`resumen: ${resumen}`);

  const descarga = page.waitForEvent('download', { timeout: 30000 });
  await page.click('#btnDescargar');
  try {
    const d = await descarga;
    d.suggestedFilename().endsWith('.zip') ? ok(`genera el ZIP («${d.suggestedFilename()}»)`) : mal(`nombre raro: ${d.suggestedFilename()}`);
  } catch { mal('no llegó a descargar el ZIP'); }
  await page.close();
}

await nav.close();
console.log(`\n${'─'.repeat(56)}`);
console.log(fallos.length ? `❌ ${fallos.length} fallo(s)` : '✅ Panel correcto');
process.exit(fallos.length ? 1 : 0);

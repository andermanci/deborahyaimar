import { chromium } from 'playwright';

const BASE = 'http://127.0.0.1:4321';
const PANEL = `${BASE}/admin/`;
const USUARIO = 'novios';
const CLAVE = 'clave-de-prueba';
const TOKEN = 'token-de-prueba.firma';
const fallos = [];
const ok = (m) => console.log(`  ✓ ${m}`);
const mal = (m) => { fallos.push(m); console.log(`  ✗ ${m}`); };

const foto = (id, extra = {}) => ({
  id, tipo: 'foto', origen: 'invitado', categoria: null, nombre: 'María',
  oculta: false, thumb: `${BASE}/foto2.jpg`, web: `${BASE}/foto2.jpg`, poster: null,
  duracion: null, ancho: 1200, alto: 800, ts: 1000, ...extra,
});

let datos = [];
let categorias = [{ slug: 'ceremonia', nombre: 'Ceremonia' }, { slug: 'baile', nombre: 'Baile' }];
const peticiones = [];

/** El acceso ahora pide usuario y contraseña. */
async function entrarEn(pg) {
  await pg.fill('#usuario', USUARIO);
  await pg.fill('#clave', CLAVE);
  await pg.click('#entrar');
}

const nav = await chromium.launch({ channel: 'chrome' });
const ctx = await nav.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });

async function nuevaPagina() {
  const page = await ctx.newPage();
  page.on('pageerror', (e) => mal(`error JS: ${e.message}`));
  // Ojo: el panel vive en /admin/, así que un glob '**/admin/**' interceptaría
  // también la navegación a la página. Se enumeran las rutas de la API.
  await page.route('**/categorias.json*', (r) => r.fulfill({ status: 200, contentType: 'application/json',
    body: JSON.stringify({ categorias }) }));
  await page.route(/\/admin\/(login|media|stats|ocultar|eliminar|categoria|categorias|limpiar-parciales)\b/, async (r) => {
    const req = r.request();
    const url = new URL(req.url());
    peticiones.push({ ruta: url.pathname, cuerpo: req.postData() ? JSON.parse(req.postData()) : null,
                      auth: req.headers()['authorization'] });

    if (url.pathname === '/admin/login') {
      const c = JSON.parse(req.postData() ?? '{}');
      if (c.usuario?.toLowerCase() !== USUARIO || c.password !== CLAVE) {
        return r.fulfill({ status: 401, contentType: 'application/json', body: '{"error":"usuario o contraseña incorrectos"}' });
      }
      return r.fulfill({ status: 200, contentType: 'application/json',
        body: JSON.stringify({ ok: true, token: TOKEN, expira: Date.now() + 3600_000, usuario: USUARIO }) });
    }

    // El resto exige el token de sesión, no la contraseña.
    if (req.headers()['authorization'] !== `Bearer ${TOKEN}`) {
      return r.fulfill({ status: 401, contentType: 'application/json', body: '{"error":"no autorizado"}' });
    }
    if (url.pathname === '/admin/media')  return r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ items: datos, total: datos.length }) });
    if (url.pathname === '/admin/stats')  return r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({
      total: 4, visibles: 3, ocultas: 1, fotos: 2, videos: 1, invitados: 3, oficiales: 0, personas: 2,
      ranking: [{ nombre: 'María', n: 2 }, { nombre: 'Jon', n: 1 }],
      porHora: [{ hora: '19', n: 1 }, { hora: '20', n: 2 }],
      almacenamiento: { bytes: 2 * 1024 ** 3, objetos: 8, limiteBytes: 10 * 1024 ** 3 },
    }) });
    if (url.pathname === '/admin/categorias') {
      const c = JSON.parse(req.postData() ?? '{}');
      const slug = c.nombre.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]+/g, '-');
      categorias = [...categorias, { slug, nombre: c.nombre }];
      return r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, slug, nombre: c.nombre }) });
    }
    if (url.pathname === '/admin/categorias/borrar') {
      const c = JSON.parse(req.postData() ?? '{}');
      const n = datos.filter((d) => d.categoria === c.slug).length;
      categorias = categorias.filter((x) => x.slug !== c.slug);
      return r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, fotosSinCategoria: n }) });
    }
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

  await page.fill('#usuario', USUARIO);
  await page.fill('#clave', 'incorrecta');
  await page.click('#entrar');
  await page.waitForTimeout(900);
  let err = await page.locator('#accesoError').textContent();
  err?.includes('incorrectos') ? ok('contraseña mala → mensaje claro') : mal(`mensaje: "${err}"`);

  await page.fill('#usuario', 'otro');
  await page.fill('#clave', CLAVE);
  await page.click('#entrar');
  await page.waitForTimeout(900);
  err = await page.locator('#accesoError').textContent();
  err?.includes('incorrectos') ? ok('usuario malo → mismo mensaje (no revela cuál falló)') : mal(`mensaje: "${err}"`);
  (await page.locator('.celda').count()) === 0 ? ok('sigue sin mostrar fotos') : mal('mostró fotos sin entrar');

  await entrarEn(page);
  await page.waitForSelector('.celda', { timeout: 8000 });
  ok('con usuario y contraseña correctos entra');

  const guardado = await page.evaluate(() => sessionStorage.getItem('ad-sesion'));
  guardado?.includes(TOKEN) && !guardado.includes(CLAVE)
    ? ok('guarda el token, NO la contraseña')
    : mal('guarda algo que no debe');

  const conAuth = peticiones.filter((x) => x.ruta === '/admin/media');
  conAuth.every((x) => x.auth === `Bearer ${TOKEN}`)
    ? ok('las peticiones van con el token de sesión')
    : mal('alguna petición no lleva el token');

  await page.click('#btnSalir');
  await page.waitForTimeout(400);
  (await page.locator('#panel').isHidden()) ? ok('«Salir» cierra la sesión') : mal('no cierra sesión');
  (await page.evaluate(() => sessionStorage.getItem('ad-sesion'))) === null
    ? ok('y borra el token del navegador') : mal('deja el token guardado');
  await page.close();
}

// ══ 2. Ve las ocultas ════════════════════════════════════════════════
console.log('\n2) Papelera: ver y restaurar lo oculto');
{
  const page = await nuevaPagina();
  datos = [foto('v1'), foto('o1', { oculta: true, nombre: 'Jon' }), foto('o2', { oculta: true, nombre: 'Jon' })];
  await page.goto(PANEL, { waitUntil: 'networkidle' });
  await entrarEn(page);
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
  await entrarEn(page);
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
  await entrarEn(page);
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
  await entrarEn(page);
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
    claveFirmar = r.request().headers()['authorization'];
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
  await entrarEn(page);
  await page.waitForTimeout(700);
  await page.click('.seccion[data-vista="subir"]');
  await page.selectOption('#catSubida', 'baile');

  const { readFileSync } = await import('fs');
  await page.setInputFiles('#ficheros', { name: 'r.jpg', mimeType: 'image/jpeg', buffer: readFileSync('public/foto2.jpg') });
  await page.waitForFunction(() => document.getElementById('progresoTxt')?.textContent?.includes('Listo'), { timeout: 60000 })
    .then(() => ok('la subida del reportaje se completa')).catch(() => mal('no completó'));

  firmadoCon?.origen === 'oficial' ? ok('pide firma con origen oficial') : mal(`origen: ${firmadoCon?.origen}`);
  claveFirmar === `Bearer ${TOKEN}` ? ok('manda el token de sesión al firmar') : mal(`autorización: ${claveFirmar}`);
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
  await entrarEn(page);
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

// ══ 8. Categorías ════════════════════════════════════════════════════
console.log('\n8) Crear y borrar categorías');
{
  categorias = [{ slug: 'ceremonia', nombre: 'Ceremonia' }, { slug: 'baile', nombre: 'Baile' }];
  const page = await nuevaPagina();
  datos = [foto('c1', { origen: 'oficial', categoria: 'baile' }), foto('c2', { origen: 'oficial', categoria: 'baile' })];
  await page.goto(PANEL, { waitUntil: 'networkidle' });
  await entrarEn(page);
  await page.waitForSelector('#panel:not([hidden])', { timeout: 8000 });
  await page.waitForTimeout(700);

  await page.click('.seccion[data-vista="categorias"]');
  await page.waitForTimeout(700);
  (await page.locator('.fila-cat').count()) === 2 ? ok('lista las categorías existentes') : mal('no las lista');
  const conteo = await page.locator('.fila-cat').nth(1).locator('.cuantas').textContent();
  conteo === '2 fotos' ? ok('dice cuántas fotos tiene cada una') : mal(`conteo: ${conteo}`);
  (await page.locator('.fila-cat').first().locator('.cuantas').textContent()) === 'sin fotos'
    ? ok('y marca las vacías') : mal('no marca las vacías');

  // Crear
  await page.fill('#catNueva', 'Photocall');
  await page.click('#btnCrearCat');
  await page.waitForTimeout(900);
  (await page.locator('.fila-cat').count()) === 3 ? ok('crear añade una nueva') : mal('no se añadió');
  const creada = peticiones.find((x) => x.ruta === '/admin/categorias');
  creada?.cuerpo?.nombre === 'Photocall' ? ok('manda el nombre escrito') : mal(`petición: ${JSON.stringify(creada)}`);
  (await page.locator('#catNueva').inputValue()) === '' ? ok('vacía el campo tras crear') : mal('no vacía el campo');

  // Borrar una CON fotos: debe avisar de que las fotos NO se borran
  let textoAviso = '';
  page.once('dialog', async (d) => { textoAviso = d.message(); await d.accept(); });
  await page.locator('.fila-cat').nth(1).locator('button').click();
  await page.waitForTimeout(1200);
  textoAviso.includes('NO se borran') && textoAviso.includes('2 fotos')
    ? ok('al borrar, avisa de cuántas fotos y de que no se pierden')
    : mal(`aviso: "${textoAviso}"`);
  (await page.locator('.fila-cat').count()) === 2 ? ok('la categoría desaparece') : mal('sigue ahí');

  // El desplegable de subida se alimenta de la lista
  await page.click('.seccion[data-vista="subir"]');
  await page.waitForTimeout(600);
  const opciones = await page.locator('#catSubida option').allTextContents();
  opciones.includes('Photocall') && !opciones.includes('Baile')
    ? ok(`el desplegable de subida se actualiza (${opciones.join(', ')})`)
    : mal(`opciones: ${opciones.join(', ')}`);
  await page.close();
}

await nav.close();
console.log(`\n${'─'.repeat(56)}`);
console.log(fallos.length ? `❌ ${fallos.length} fallo(s)` : '✅ Panel correcto');
process.exit(fallos.length ? 1 : 0);

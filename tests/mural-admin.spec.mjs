import { chromium } from 'playwright';
const BASE = 'http://127.0.0.1:4321';
const fallos = [];
const ok = (m) => console.log('  ✓ ' + m);
const mal = (m) => { fallos.push(m); console.log('  ✗ ' + m); };
const nav = await chromium.launch({ channel: 'chrome' });
const ctx = await nav.newContext({ viewport: { width: 1280, height: 720 } });

const items = [
  { id: 'm1', tipo: 'foto', nombre: 'Ander', thumb: BASE + '/foto2.jpg', web: BASE + '/foto2.jpg', poster: null, duracion: null, ancho: 1200, alto: 800, ts: 2, categoria: null, deviceId: 'd' },
  { id: 'm2', tipo: 'foto', nombre: '<b>Jon</b>', thumb: BASE + '/foto3.jpg', web: BASE + '/foto3.jpg', poster: null, duracion: null, ancho: 800, alto: 1200, ts: 1, categoria: null, deviceId: 'd' },
];

console.log('\nMURAL');
{
  const p = await ctx.newPage();
  p.on('pageerror', (e) => mal('error JS en mural: ' + e.message));
  await p.route('**/indice.json*', (r) => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ items }) }));
  await p.goto(BASE + '/mural/', { waitUntil: 'networkidle' });
  await p.waitForTimeout(1200);
  (await p.locator('.diapo.activa').count()) === 1 ? ok('muestra una diapositiva') : mal('no muestra diapositiva');
  (await p.locator('#aviso').isHidden()) ? ok('oculta el aviso al haber fotos') : mal('sigue mostrando el aviso');
  const autor = await p.locator('#autor').textContent();
  autor === 'Ander' ? ok('muestra el autor') : mal('autor: ' + autor);
  (await p.locator('#autor b').count()) === 0 ? ok('el nombre no se interpreta como HTML') : mal('¡HTML inyectado en el mural!');
  await p.close();
}

console.log('\nPANEL DE MODERACIÓN');
{
  const p = await ctx.newPage();
  p.on('pageerror', (e) => mal('error JS en panel: ' + e.message));
  let moderarCon = null;
  await p.route('**/indice.json*', (r) => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ items }) }));
  await p.route('**/moderar', async (r) => { moderarCon = JSON.parse(r.request().postData()); await r.fulfill({ status: 200, contentType: 'application/json', body: '{"ok":true}' }); });
  await p.goto(BASE + '/admin-68895abc/', { waitUntil: 'networkidle' });
  (await p.locator('.celda').count()) === 0 ? ok('no muestra nada sin contraseña') : mal('mostró fotos sin contraseña');
  await p.fill('#pw', 'secreta');
  await p.click('#entrar');
  await p.waitForSelector('.celda', { timeout: 5000 });
  (await p.locator('.celda').count()) === 2 ? ok('lista las fotos tras entrar') : mal('no listó las fotos');
  (await p.locator('.quien b').count()) === 0 ? ok('el nombre no se interpreta como HTML') : mal('¡HTML inyectado en el panel!');
  await p.locator('.celda button').first().click();
  await p.waitForTimeout(600);
  moderarCon?.password === 'secreta' && moderarCon?.ocultar === true ? ok('envía la orden de ocultar con contraseña') : mal('petición incorrecta: ' + JSON.stringify(moderarCon));
  (await p.locator('.celda.oculta').count()) === 1 ? ok('marca la foto como oculta') : mal('no marcó la foto');
  await p.close();
}

await nav.close();
console.log('\n' + '─'.repeat(52));
console.log(fallos.length ? '❌ ' + fallos.length + ' fallo(s)' : '✅ Mural y panel correctos');
process.exit(fallos.length ? 1 : 0);

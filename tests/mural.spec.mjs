// El panel de los novios tiene su propia suite en panel.spec.mjs.
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

await nav.close();
console.log('\n' + '─'.repeat(52));
console.log(fallos.length ? '❌ ' + fallos.length + ' fallo(s)' : '✅ Mural correcto');
process.exit(fallos.length ? 1 : 0);

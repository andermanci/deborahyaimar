import { chromium } from 'playwright';

const BASE = 'http://127.0.0.1:4321';
const fallos = [];
const ok = (m) => console.log(`  ✓ ${m}`);
const mal = (m) => { fallos.push(m); console.log(`  ✗ ${m}`); };

const navegador = await chromium.launch({ channel: 'chrome', args: ['--autoplay-policy=no-user-gesture-required'] });
const ctx = await navegador.newContext({ viewport: { width: 390, height: 844 } });
const page = await ctx.newPage();
page.on('pageerror', (e) => mal(`error JS: ${e.message}`));
await page.route('**/indice.json*', (r) =>
  r.fulfill({ status: 200, contentType: 'application/json', body: '{"items":[]}' }));

const PART = 5 * 1024 * 1024;
let firmado = null;
const partesSubidas = [];
let completado = null;
let fallarParte2 = true;

await page.route('**/firmar', async (r) => {
  firmado = JSON.parse(r.request().postData());
  const subidas = firmado.archivos.map((a) => {
    if (a.rol !== 'video') return { rol: a.rol, key: `invitados/v/${a.rol}.webp`, url: `${BASE}/__put/${a.rol}` };
    const n = Math.ceil(a.size / PART);
    return { rol: 'video', key: 'invitados/v/video.webm', uploadId: 'up-1', partSize: PART,
             urls: Array.from({ length: n }, (_, i) => `${BASE}/__part/${i + 1}`) };
  });
  await r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ id: 'v', subidas }) });
});

await page.route('**/__part/**', async (r) => {
  const n = Number(r.request().url().split('/').pop());
  // La parte 2 falla la primera vez: así comprobamos que al reintentar NO se
  // vuelve a subir la parte 1.
  if (n === 2 && fallarParte2) { fallarParte2 = false; return r.fulfill({ status: 500, body: '' }); }
  partesSubidas.push(n);
  await r.fulfill({ status: 200, headers: { ETag: `"etag-${n}"` }, body: '' });
});
await page.route('**/__put/**', (r) => r.fulfill({ status: 200, headers: { ETag: '"e"' }, body: '' }));
await page.route('**/completar', async (r) => {
  completado = JSON.parse(r.request().postData());
  await r.fulfill({ status: 200, contentType: 'application/json', body: '{"ok":true}' });
});

await page.clock.install({ time: new Date('2026-09-12T18:00:00+02:00') });
await page.goto(`${BASE}/galeria/`, { waitUntil: 'networkidle' });

console.log('\nGenerando un vídeo real con MediaRecorder…');
const info = await page.evaluate(async () => {
  const c = document.createElement('canvas');
  c.width = 1280; c.height = 720;
  const g = c.getContext('2d');
  const stream = c.captureStream(30);
  const rec = new MediaRecorder(stream, { mimeType: 'video/webm', videoBitsPerSecond: 25_000_000 });
  const trozos = [];
  rec.ondataavailable = (e) => trozos.push(e.data);
  rec.start();
  // Ruido cambiante: si pintamos un color plano, el códec lo comprime a nada.
  for (let f = 0; f < 90; f++) {
    const img = g.createImageData(c.width, c.height);
    for (let i = 0; i < img.data.length; i += 4) {
      img.data[i] = Math.random() * 255; img.data[i + 1] = Math.random() * 255;
      img.data[i + 2] = Math.random() * 255; img.data[i + 3] = 255;
    }
    g.putImageData(img, 0, 0);
    await new Promise((r) => setTimeout(r, 33));
  }
  rec.stop();
  await new Promise((r) => { rec.onstop = r; });
  const blob = new Blob(trozos, { type: 'video/webm' });
  const file = new File([blob], 'baile.webm', { type: 'video/webm' });
  const dt = new DataTransfer();
  dt.items.add(file);
  const input = document.getElementById('ufFileInput');
  input.files = dt.files;
  input.dispatchEvent(new Event('change', { bubbles: true }));
  return { bytes: blob.size };
});
console.log(`  vídeo de ${(info.bytes / 1024 / 1024).toFixed(1)} MB (${Math.ceil(info.bytes / PART)} partes esperadas)`);

await page.fill('#ufNombre', 'Ander');
await page.click('#ufSubmitBtn');

let listo = false;
for (let i = 0; i < 60 && !listo; i++) {
  await page.clock.runFor(10_000);
  await page.waitForTimeout(200);
  listo = (await page.locator('#ufColaTexto').textContent()).includes('Gracias');
}

console.log('\nResultado:');
listo ? ok('la subida del vídeo se completa') : mal('el vídeo nunca terminó');

const v = firmado?.archivos.find((a) => a.rol === 'video');
const poster = firmado?.archivos.find((a) => a.rol === 'poster');
const thumb = firmado?.archivos.find((a) => a.rol === 'thumb');
v ? ok(`pide firma de vídeo (${(v.size / 1024 / 1024).toFixed(1)} MB, ${v.contentType})`) : mal('no pidió firma de vídeo');
poster && thumb ? ok(`extrae portada (poster ${(poster.size / 1024).toFixed(0)} KB + thumb ${(thumb.size / 1024).toFixed(0)} KB)`) : mal('no extrajo portada');

const esperadas = Math.ceil(info.bytes / PART);
const unicas = [...new Set(partesSubidas)].sort((a, b) => a - b);
unicas.length === esperadas ? ok(`sube las ${esperadas} partes`) : mal(`subió ${unicas.length} de ${esperadas}`);

// La clave: la parte 1 se subió UNA sola vez pese al fallo de la parte 2.
const vecesParte1 = partesSubidas.filter((n) => n === 1).length;
vecesParte1 === 1
  ? ok('tras fallar la parte 2, NO reenvía la parte 1 (reanuda de verdad)')
  : mal(`reenvió la parte 1 ${vecesParte1} veces: no está reanudando`);

completado?.partes?.length === esperadas ? ok('envía los ETag de todas las partes al cerrar') : mal(`ETags: ${completado?.partes?.length}`);
completado?.key_poster ? ok('registra la portada') : mal('no registra la portada');
completado?.duracion_s > 0 ? ok(`registra la duración (${completado.duracion_s.toFixed(1)}s)`) : mal('no registra duración');

await navegador.close();
console.log(`\n${'─'.repeat(52)}`);
console.log(fallos.length ? `❌ ${fallos.length} fallo(s)` : '✅ Vídeo y reanudación correctos');
process.exit(fallos.length ? 1 : 0);

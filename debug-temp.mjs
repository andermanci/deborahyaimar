import { chromium } from 'playwright';
import { readFileSync } from 'fs';
const nav = await chromium.launch({ channel: 'chrome' });
const ctx = await nav.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
const page = await ctx.newPage();

page.on('response', async (res) => {
  if (!res.url().includes('indice.json')) return;
  try {
    const b = await res.json();
    const oficial = res.url().includes('oficial');
    console.log(`   [${new Date().toISOString().slice(14,19)}] ${oficial ? 'oficial' : 'invitado'} → total=${b.total} · cf=${res.headers()['cf-cache-status']} · age=${res.headers()['age'] ?? '-'} · fromCache=${res.fromServiceWorker()}`);
  } catch {}
});

await page.goto('https://deborahyaimar.com/galeria/', { waitUntil: 'networkidle' });
await page.setInputFiles('#selector', { name: 'x.jpg', mimeType: 'image/jpeg', buffer: readFileSync('public/foto2.jpg') });
await page.fill('#nombreInput', 'Sonda');
await page.click('#hojaBoton');
await page.waitForFunction(() => document.getElementById('progresoTexto')?.textContent?.includes('Gracias'), { timeout: 90000 });
console.log('  --- subida hecha, recargando en 20 s ---');
await page.waitForTimeout(20000);
await page.reload({ waitUntil: 'networkidle' });
console.log('  --- recargado, observando 50 s ---');
for (let i = 0; i < 5; i++) {
  await page.waitForTimeout(10000);
  console.log(`   tarjetas en pantalla: ${await page.locator('.tarjeta').count()}`);
}
await nav.close();

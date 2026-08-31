# Pruebas de la galería

Navegador real (Chrome instalado, vía Playwright). No necesitan cuenta de Cloudflare:
el backend va mockeado con `page.route`.

```sh
npm run build && npx astro preview --port 4321 &
npm test
```

- `galeria.spec.mjs` — render, XSS del nombre, vídeo, lightbox, swipe, subida de foto.
- `resiliencia.spec.mjs` — subida que falla, caída de red, cierre de pestaña a medias.
- `video.spec.mjs` — multipart de vídeo y **reanudación** (que no reenvíe partes ya subidas).

`resiliencia` y `video` usan relojes falsos (`page.clock.install`) para adelantar el
backoff exponencial sin esperar minutos reales.

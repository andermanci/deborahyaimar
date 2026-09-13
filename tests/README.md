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
- `panel.spec.mjs` — panel de los novios: acceso, papelera, borrado definitivo,
  filtros, resumen, subida del reportaje y descarga en ZIP.
- `safari.spec.mjs` — el flujo completo en el motor de Safari (WebKit). Detecta que
  Safari sube JPEG y el fallo de IndexedDB en navegación privada.
- `lento.spec.mjs` — subida limitada a 300 kbps con un receptor HTTP real (los bytes
  salen de verdad). Vigila que no haya reenvíos y que la barra avance.
- `produccion.spec.mjs` — humo contra el sitio **real** (deborahyaimar.com + R2 + Worker).
  No usa mocks: sube una foto de verdad. Ejecutar antes de la boda, y borrar
  después la foto de prueba (nombre «Ensayo Claude») desde el panel de moderación.

> **Ojo con `/original`.** Toda subida en calidad original llama a ese endpoint al
> terminar. Si un test genera una foto grande y no lo mockea, la petición sale al API
> **de producción**. Los `public/*.jpg` son pequeños y no producen original; las fotos
> sintéticas grandes, sí. Y regístralo DESPUÉS de `**/__put/**`: Playwright prueba las
> rutas de la última a la primera, y `**/original` casaría también con el PUT.

`resiliencia` y `video` usan relojes falsos (`page.clock.install`) para adelantar el
backoff exponencial sin esperar minutos reales.

# Puesta en marcha de la galería

Todo lo que hay que configurar fuera del código. El orden importa.

---

## 0. El dominio: uno nuevo, y el de la boda no se toca

`deborahyaimar.com` se compró **a través de Netlify**, que es revendedor de Name.com. Eso
significa que Netlify bloquea los nameservers (aparecen con candado) y no hay autoservicio
para cambiarlos. Y para transferirlo a Cloudflare hay un círculo imposible: Cloudflare
exige que el dominio ya esté activo en su DNS *antes* de aceptar la transferencia.

Salida: **registrar `deborahyaimar.org` en Cloudflare Registrar** (~10 €/año). Queda dentro
de Cloudflare al instante, con sus nameservers ya puestos. Nada que migrar, nada que
propagar, y `deborahyaimar.com` intacto en Netlify.

Reparto final:

| Dominio | Dónde | Para qué |
|---|---|---|
| `deborahyaimar.com` | Netlify (sin tocar) | La web y el QR (`/fotos`) |
| `fotos.deborahyaimar.org` | Cloudflare R2 | Las fotos y vídeos |
| `api.deborahyaimar.org` | Cloudflare Worker | Firmas e índice |

Las dos URLs `.net` no las teclea nadie: son direcciones internas de imágenes y de API.

---

## 1-4. Infraestructura de Cloudflare — ✅ HECHO (31/08/2026)

Todo esto ya está creado, desplegado y verificado contra producción:

| Pieza | Estado |
|---|---|
| Bucket R2 `ad-media` (EU) | ✅ creado |
| CORS con `ExposeHeaders: ["ETag"]` | ✅ aplicado y verificado con multipart real |
| `fotos.deborahyaimar.org` → bucket | ✅ conectado, sirviendo con `cf-cache-status: HIT` |
| Base D1 `ad-galeria` | ✅ creada, esquema aplicado (colo MAD) |
| Worker `ad-galeria-api` | ✅ desplegado |
| `api.deborahyaimar.org` → Worker | ✅ conectado |
| Secretos (`R2_*`, `ADMIN_USER`, `ADMIN_PASSWORD`) | ✅ guardados |

**Regla de caché para vídeo: NO hace falta.** Se comprobó empíricamente que Cloudflare ya
cachea `.mp4` y `.webm` por defecto desde un dominio de R2 (MISS en la primera petición,
HIT en las siguientes). El paso que había aquí sobraba.

### Verificación hecha contra producción

- `cf-cache-status: HIT` en `/indice.json` — lo único que separa este diseño del que se
  caía a los 4 minutos.
- Subida completa de foto: firmar → PUT a R2 → registrar → servir. ✅
- **Multipart de vídeo real contra R2**: 12 MB en 3 partes, ETags leídos correctamente
  (o sea, el CORS está bien), cierre del multipart, y el vídeo vuelve con 12,0 MB exactos
  sin corromperse. ✅
- Todas las rutas `/admin/*` sin token → 401. ✅
- Datos de prueba borrados; bucket e índice vacíos.

---

## 4-bis. Pendiente: rotar credenciales

Las credenciales S3 que usa el Worker se derivaron del API token de despliegue, así que
pueden más de lo que deberían. Para dejarlo limpio:

1. **R2 → API → Manage API tokens → Create** con permiso **Object Read & Write** sobre
   `ad-media`.
2. ```sh
   cd workers/api
   npx wrangler secret put R2_ACCESS_KEY_ID       # el nuevo Access Key ID
   npx wrangler secret put R2_SECRET_ACCESS_KEY   # el nuevo Secret
   ```
   No hace falta redesplegar: los secretos se aplican al instante.
3. Borrar el API token de despliegue desde **My Profile → API Tokens**.

---

## 5. Variables en Netlify — PENDIENTE (lo único que falta)

**Site configuration → Environment variables → Add a variable:**

```
PUBLIC_API_BASE   = https://api.deborahyaimar.org
PUBLIC_MEDIA_BASE = https://fotos.deborahyaimar.org
```

Luego **Deploys → Trigger deploy → Deploy site**.

Borra también las variables `*_CLOUDINARY_*`, que ya no se usan, y revoca esa API key
desde el panel de Cloudinary.

---

## 4-ter. El panel de los novios

**`deborahyaimar.com/admin`** · usuario `admin` · contraseña `DeborahAimar12`.

Se cambian con `wrangler secret put ADMIN_USER` y `ADMIN_PASSWORD` desde `workers/api`.
Cambiar la contraseña cierra todas las sesiones abiertas, porque el token se firma con ella.

Al entrar se recibe un token firmado con 12 h de caducidad; la contraseña no se guarda en
el navegador ni se reenvía. El secreto `ADMIN_USER` define el usuario, y el token se firma
con `ADMIN_PASSWORD`, así que **cambiar la contraseña invalida todas las sesiones abiertas**.

Desde ahí: ver todo incluidas las ocultas, papelera con restaurar, borrado definitivo (que
se lleva los bytes de R2), filtros, resumen con el espacio ocupado, subida del reportaje
por categorías y descarga del álbum en ZIP.

### Pendiente de un clic tuyo

**Cron de limpieza nocturna.** El código está desplegado, pero Cloudflare no acepta
programar crons hasta que la cuenta tenga subdominio `workers.dev`, que se crea solo al
abrir el menú **Workers & Pages** una primera vez. Después:
**Workers & Pages → ad-galeria-api → Settings → Triggers → Cron Triggers → Add** → `0 4 * * *`.

Sin él no pasa nada grave: limpia subidas de vídeo abandonadas, y el panel tiene el mismo
botón en «Resumen».

**Regla de rate limiting en el login (recomendada).** `/firmar` es público por diseño y
`/admin/login` ahora vive en una ruta adivinable. El plan gratuito incluye **una** regla:
**Security → WAF → Rate limiting rules → Create**, con
`http.request.uri.path eq "/admin/login"`, 10 peticiones / 10 segundos por IP, acción
*Block* 1 minuto. Uso legítimo: dos peticiones en toda la boda, así que no molesta a nadie
y cierra tanto la fuerza bruta como el riesgo de que alguien agote la cuota del Worker.

---

## 5. El QR

El QR impreso apunta a **`deborahyaimar.com/fotos`**, nunca a `/galeria` directamente.
El redirect vive en `netlify.toml`. Si algo falla el día de la boda, se cambia el destino
y se redespliega en 30 segundos, sin reimprimir nada.

---

## 6. Comprobaciones antes del día

```sh
# El índice se cachea en el borde (debe decir HIT en la segunda llamada)
curl -sI https://api.deborahyaimar.org/indice.json | grep -i "cf-cache-status\|cache-control"
curl -sI https://api.deborahyaimar.org/indice.json | grep -i cf-cache-status

# Los vídeos se cachean (segunda llamada: HIT)
curl -sI https://fotos.deborahyaimar.org/<una-clave>.webm | grep -i cf-cache-status

# El panel debe rechazar todo sin sesión
curl -s -o /dev/null -w "%{http_code}\n" https://api.deborahyaimar.org/admin/media   # → 401

# Y el login debe rechazar credenciales malas
curl -s -X POST https://api.deborahyaimar.org/admin/login \
  -H 'Content-Type: application/json' -d '{"usuario":"novios","password":"mal"}'
```

**Si `cf-cache-status` nunca dice `HIT` en `/indice.json`, para y arréglalo antes de la
boda.** Esa caché es lo único que separa este diseño del que se caía a los 4 minutos.

---

## Presupuesto (plan gratuito)

| Recurso | Límite | Estimado |
|---|---|---|
| R2 almacenamiento | 10 GB | ~6,7 GB |
| R2 egress | ilimitado | ~50-100 GB |
| Workers | 100 k/día | ~6 k/día |
| D1 filas leídas | 5 M/día | ~260 k |

Pasarse de los 10 GB **no provoca caída**: cuesta 0,015 $/GB de exceso. Revisa el panel
de R2 la semana siguiente a la boda.

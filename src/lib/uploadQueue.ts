/**
 * Cola de subida persistente.
 *
 * Lo que separa "funciona en mi mesa" de "funciona en una boda":
 *  - Los blobs ya procesados se guardan en IndexedDB ANTES de intentar nada,
 *    así que la subida sobrevive a cerrar la pestaña, bloquear el móvil o
 *    quedarse sin batería.
 *  - Las fotos (~500 KB) se reintentan enteras. Los vídeos van por partes de
 *    5 MB y cada parte completada se anota, así que al recuperar cobertura se
 *    reanuda donde se quedó en vez de empezar de cero.
 *  - Nada se marca como hecho hasta que el servidor lo confirma. Nunca damos
 *    las gracias por una foto que no ha llegado.
 */

import type { MedioProcesado } from './media';

const DB_NOMBRE = 'ad-galeria';
const DB_VERSION = 1;
const ALMACEN = 'cola';
const CONCURRENCIA = 3;
const MAX_INTENTOS = 6;

// fetch NO tiene tiempo de espera por defecto. En un móvil que pierde
// cobertura a media petición, la promesa puede no resolverse NUNCA: la cola se
// queda colgada y ya no la despierta ni volver la conexión. Todo lo que sale a
// la red lleva plazo.
const PLAZO_API = 20_000;      // firmar / completar: son peticiones pequeñas
const PLAZO_FOTO = 90_000;     // ~500 KB con cobertura mala
const PLAZO_PARTE = 180_000;   // trozo de vídeo de 5 MB

// Red de seguridad para elementos abandonados por una pestaña que murió. Es
// deliberadamente generoso porque un vídeo grande tarda de verdad: 20 partes
// de hasta 3 minutos. Lo que evita duplicados de verdad es `trabajando`, el
// conjunto de lo que ESTA página está subiendo ahora mismo.
const PLAZO_HUERFANO = 30 * 60_000;

// Reintento periódico. Sin esto, recuperarse de un atasco dependía de que el
// usuario cambiara de pestaña o le volviera la cobertura: si se quedaba
// mirando la pantalla, la cola no se movía nunca.
const LATIDO = 20_000;

export type EstadoItem = 'pendiente' | 'subiendo' | 'hecho' | 'fallido';

export interface SubidaFirmada {
  rol: string;
  key: string;
  url?: string;          // PUT simple (fotos y posters)
  uploadId?: string;     // multipart (vídeo)
  partSize?: number;
  urls?: string[];
}

export interface ItemCola {
  id: string;                       // id local, no el del servidor
  estado: EstadoItem;
  tipo: 'foto' | 'video';
  nombre: string;
  deviceId: string;
  blobs: Record<string, Blob>;      // thumb | web | poster | video
  meta: { ancho: number; alto: number; duracion?: number };
  servidorId?: string;
  claves?: Record<string, string>;  // rol -> key en R2
  subidas?: SubidaFirmada[];        // se persiste: al recargar se reanuda sin refirmar
  partes?: { n: number; etag: string }[];
  intentos: number;
  error?: string;
  creado: number;
  marcadoEn?: number;    // cuándo pasó a «subiendo», para detectar huérfanos
  reintentarEn?: number; // no volver a intentarlo antes de este instante
  opciones?: OpcionesSubida;
}

/**
 * Solo lo usa el panel de los novios, para el reportaje oficial. Sin esto, la
 * cola se comporta exactamente igual que para un invitado.
 */
export interface OpcionesSubida {
  origen?: 'invitado' | 'oficial';
  categoria?: string | null;
  token?: string;   // sesión del panel; el servidor la exige si origen es 'oficial'
}

export interface ResumenCola {
  total: number;
  hechos: number;
  subiendo: number;
  fallidos: number;
  pendientes: number;
  reintentando: number;   // pendientes que ya fallaron alguna vez
  sinConexion: boolean;   // la cola está parada esperando cobertura
  ultimoError?: string;   // motivo del último fallo, aunque aún esté reintentando
  items: ItemCola[];
}

// ── IndexedDB ─────────────────────────────────────────────────────────

function abrir(): Promise<IDBDatabase> {
  return new Promise((res, rej) => {
    const req = indexedDB.open(DB_NOMBRE, DB_VERSION);
    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains(ALMACEN)) {
        req.result.createObjectStore(ALMACEN, { keyPath: 'id' });
      }
    };
    req.onsuccess = () => res(req.result);
    req.onerror = () => rej(req.error);
  });
}

async function tx<T>(modo: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const db = await abrir();
  return new Promise<T>((res, rej) => {
    const t = db.transaction(ALMACEN, modo);
    const req = fn(t.objectStore(ALMACEN));
    req.onsuccess = () => res(req.result);
    req.onerror = () => rej(req.error);
    t.oncomplete = () => db.close();
  });
}

const guardar = (item: ItemCola) => tx('readwrite', (s) => s.put(item));
const borrar = (id: string) => tx('readwrite', (s) => s.delete(id));
const leerTodo = () => tx<ItemCola[]>('readonly', (s) => s.getAll());

// ── Utilidades ────────────────────────────────────────────────────────

const esperar = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Se lanza cuando el usuario para la subida a propósito. */
export class Cancelado extends Error {}

/**
 * fetch con plazo y con cancelación.
 * Sin plazo, una petición colgada mata la cola entera; sin señal externa, el
 * botón de parar no podría cortar lo que ya está en vuelo.
 */
async function fetchConPlazo(
  url: string, opciones: RequestInit, ms: number, externa?: AbortSignal,
): Promise<Response> {
  const ctrl = new AbortController();
  const cortar = () => ctrl.abort();
  externa?.addEventListener('abort', cortar, { once: true });
  const reloj = setTimeout(() => ctrl.abort(), ms);
  try {
    return await fetch(url, { ...opciones, signal: ctrl.signal });
  } catch (err) {
    if (externa?.aborted) throw new Cancelado('Subida cancelada');
    if (ctrl.signal.aborted) throw new Error('Se agotó el tiempo de espera. ¿Hay cobertura?');
    throw err;
  } finally {
    clearTimeout(reloj);
    externa?.removeEventListener('abort', cortar);
  }
}

/** Backoff exponencial con jitter: evita que 150 móviles reintenten a la vez. */
function retardo(intento: number): number {
  const base = Math.min(30_000, 1000 * 2 ** intento);
  return base * (0.5 + Math.random() * 0.5);
}

// ── Cola ──────────────────────────────────────────────────────────────

export class ColaSubida {
  private api: string;
  private corriendo = false;
  private inicioRonda = 0;
  /** Lo que esta página está subiendo AHORA: nunca debe reclamarse como huérfano. */
  private trabajando = new Set<string>();
  /** Para cortar en seco lo que ya está en vuelo cuando el usuario cancela. */
  private abortadores = new Map<string, AbortController>();
  private cancelando = false;
  private oyentes: ((r: ResumenCola) => void)[] = [];

  constructor(apiBase: string) {
    this.api = apiBase.replace(/\/$/, '');

    // Reanudar en cuanto vuelva la conexión o el usuario vuelva a la pestaña:
    // en iOS la pestaña se congela al bloquear el móvil.
    // Al cambiar la conexión hay que refrescar el resumen ADEMÁS de reintentar:
    // si no, la barra se quedaba diciendo «Reintentando…» mientras el móvil
    // estaba sin cobertura, sin dar ninguna pista de lo que pasaba.
    addEventListener('online', () => { void this.avisar(); void this.procesar(); });
    addEventListener('offline', () => { void this.avisar(); });
    addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') { void this.avisar(); void this.procesar(); }
    });

    // Reduce el riesgo de que el navegador purgue la cola por falta de espacio.
    navigator.storage?.persist?.().catch(() => {});

    setInterval(() => void this.procesar(), LATIDO);

    void this.iniciar();
  }

  /**
   * Arranque en frío: recoge lo que dejó a medias una sesión anterior.
   * Sin esto, una subida interrumpida al cerrar la pestaña se quedaba en
   * IndexedDB para siempre y nadie la retomaba.
   */
  private async iniciar(): Promise<void> {
    // Los 'hecho' que sobreviven a una sesión ya los confirmó el servidor: solo
    // servían para enseñar «¡Gracias!» unos segundos. Si la pestaña se cerró
    // antes de limpiarlos, al volver inflaban el contador y aparecía un
    // «6 de 6» habiendo subido 3.
    const items = await leerTodo();
    for (const item of items.filter((i) => i.estado === 'hecho')) await borrar(item.id);

    await this.recuperarHuerfanos(true);
    await this.avisar();
    void this.procesar();
  }

  /**
   * Devuelve a la cola lo que se quedó a medias.
   * Al arrancar, todo lo que esté en «subiendo» es de una sesión anterior.
   * Durante la ejecución, solo lo que lleve parado más de PLAZO_HUERFANO.
   */
  private async recuperarHuerfanos(todos = false): Promise<void> {
    const items = await leerTodo();
    for (const item of items) {
      if (item.estado !== 'subiendo') continue;
      // Si lo estamos subiendo nosotros, no es un huérfano por mucho que tarde.
      // Sin esta guarda, un vídeo largo se reclamaba a mitad y se subía dos veces.
      if (this.trabajando.has(item.id)) continue;
      const parado = Date.now() - (item.marcadoEn ?? 0);
      if (todos || parado > PLAZO_HUERFANO) {
        await guardar({ ...item, estado: 'pendiente' });
      }
    }
  }

  alCambiar(fn: (r: ResumenCola) => void) {
    this.oyentes.push(fn);
  }

  private async avisar() {
    const items = await leerTodo();
    const resumen: ResumenCola = {
      total: items.length,
      hechos: items.filter((i) => i.estado === 'hecho').length,
      subiendo: items.filter((i) => i.estado === 'subiendo').length,
      fallidos: items.filter((i) => i.estado === 'fallido').length,
      pendientes: items.filter((i) => i.estado === 'pendiente').length,
      reintentando: items.filter((i) => i.estado === 'pendiente' && i.intentos > 0).length,
      sinConexion: !navigator.onLine && items.some((i) => i.estado !== 'hecho'),
      ultimoError: items.find((i) => i.error && i.estado !== 'hecho')?.error,
      items,
    };
    this.oyentes.forEach((fn) => fn(resumen));
  }

  /** Encola un medio ya procesado. Devuelve al llamante de inmediato. */
  async encolar(
    medio: MedioProcesado,
    nombre: string,
    deviceId: string,
    opciones?: OpcionesSubida,
  ): Promise<void> {
    const blobs: Record<string, Blob> = { thumb: medio.thumb };
    if (medio.tipo === 'foto') {
      blobs.web = medio.web;
    } else {
      blobs.poster = medio.poster;
      blobs.video = medio.video;
    }

    await guardar({
      id: crypto.randomUUID(),
      estado: 'pendiente',
      tipo: medio.tipo,
      nombre,
      deviceId,
      blobs,
      meta: {
        ancho: medio.ancho,
        alto: medio.alto,
        duracion: medio.tipo === 'video' ? medio.duracion : undefined,
      },
      intentos: 0,
      creado: Date.now(),
      opciones,
    });
    await this.avisar();
    void this.procesar();
  }

  /** Reintenta a mano lo que se rindió. */
  async reintentarFallidos(): Promise<void> {
    const items = await leerTodo();
    for (const item of items.filter((i) => i.estado === 'fallido')) {
      await guardar({ ...item, estado: 'pendiente', intentos: 0, error: undefined, reintentarEn: 0 });
    }
    await this.avisar();
    void this.procesar();
  }

  /**
   * Para la subida a petición del usuario: corta lo que está en vuelo y vacía
   * la cola de todo lo que no haya llegado ya al servidor. Lo ya confirmado no
   * se toca: esas fotos están en la galería y no se pueden «des-subir» desde aquí.
   */
  async cancelarTodo(): Promise<number> {
    this.cancelando = true;
    for (const ctrl of this.abortadores.values()) ctrl.abort();
    this.abortadores.clear();

    const items = await leerTodo();
    const aQuitar = items.filter((i) => i.estado !== 'hecho');
    for (const item of aQuitar) await borrar(item.id);

    this.trabajando.clear();
    this.cancelando = false;
    await this.avisar();
    return aQuitar.length;
  }

  async limpiarHechos(): Promise<void> {
    const items = await leerTodo();
    for (const item of items.filter((i) => i.estado === 'hecho')) await borrar(item.id);
    await this.avisar();
  }

  /** Bucle principal. Idempotente: llamarlo de más no hace daño. */
  async procesar(): Promise<void> {
    // Si la ronda anterior lleva colgada más que el plazo de un huérfano, se
    // da por muerta. Sin esta salida, un `corriendo` atascado deja la cola
    // inservible para el resto de la sesión.
    if (this.corriendo) {
      if (Date.now() - this.inicioRonda < PLAZO_HUERFANO) return;
    }
    this.corriendo = true;
    this.inicioRonda = Date.now();
    try {
      for (;;) {
        await this.recuperarHuerfanos();
        const items = await leerTodo();
        const pendientes = items.filter((i) => i.estado === 'pendiente');
        if (!pendientes.length) break;
        if (!navigator.onLine) break;

        const ahora = Date.now();
        const listos = pendientes.filter((i) => (i.reintentarEn ?? 0) <= ahora);

        // Todo lo pendiente está esperando su turno de reintento: dormimos
        // hasta el más próximo en vez de girar en vacío.
        if (!listos.length) {
          const proximo = Math.min(...pendientes.map((i) => i.reintentarEn ?? ahora));
          await esperar(Math.max(500, Math.min(proximo - ahora, 30_000)));
          continue;
        }

        const lote = listos.slice(0, CONCURRENCIA);
        await Promise.all(lote.map((i) => this.subirItem(i)));
        await this.avisar();
      }
    } finally {
      this.corriendo = false;
    }
  }

  private async subirItem(item: ItemCola): Promise<void> {
    await guardar({ ...item, estado: 'subiendo', marcadoEn: Date.now() });
    this.trabajando.add(item.id);
    const ctrl = new AbortController();
    this.abortadores.set(item.id, ctrl);
    await this.avisar();

    try {
      if (!item.servidorId) await this.firmar(item, ctrl.signal);
      await this.subirBlobs(item, ctrl.signal);
      await this.completar(item, ctrl.signal);

      // Soltar los blobs: ya están en R2 y ocupan MB en el móvil del invitado.
      await guardar({ ...item, estado: 'hecho', blobs: {}, subidas: undefined });
    } catch (err) {
      // Si lo ha parado el usuario, no se reencola ni se marca como fallo:
      // cancelarTodo() ya se ha llevado el elemento.
      if (this.cancelando || err instanceof Cancelado) return;

      const intentos = item.intentos + 1;
      const mensaje = err instanceof Error ? err.message : String(err);

      if (intentos >= MAX_INTENTOS) {
        await guardar({ ...item, estado: 'fallido', intentos, error: mensaje });
      } else {
        // Sin await aquí: si esperásemos dentro del lote, una foto que falla
        // frenaría a las otras dos que van bien.
        await guardar({
          ...item, estado: 'pendiente', intentos, error: mensaje,
          reintentarEn: Date.now() + retardo(intentos),
        });
      }
    } finally {
      this.trabajando.delete(item.id);
      this.abortadores.delete(item.id);
    }
  }

  private cabeceras(item: ItemCola): Record<string, string> {
    const h: Record<string, string> = { 'Content-Type': 'application/json' };
    if (item.opciones?.token) h['Authorization'] = `Bearer ${item.opciones.token}`;
    return h;
  }

  /** Pide al Worker las URLs prefirmadas. Las claves las decide el servidor. */
  private async firmar(item: ItemCola, senal?: AbortSignal): Promise<void> {
    const archivos = Object.entries(item.blobs).map(([rol, blob]) => ({
      rol,
      contentType: blob.type || (rol === 'video' ? 'video/mp4' : 'image/webp'),
      size: blob.size,
    }));

    const res = await fetchConPlazo(`${this.api}/firmar`, {
      method: 'POST',
      headers: this.cabeceras(item),
      body: JSON.stringify({ tipo: item.tipo, archivos, origen: item.opciones?.origen }),
    }, PLAZO_API, senal);
    if (!res.ok) throw new Error(`No se pudo preparar la subida (${res.status})`);

    const datos = await res.json();
    item.servidorId = datos.id;
    item.claves = {};
    item.partes = [];
    item.subidas = datos.subidas;
    for (const s of datos.subidas) item.claves[s.rol] = s.key;

    await guardar(item);
  }

  private async subirBlobs(item: ItemCola, senal?: AbortSignal): Promise<void> {
    const subidas = item.subidas;
    if (!subidas?.length) throw new Error('Falta la firma de subida');

    for (const s of subidas) {
      const blob = item.blobs[s.rol];
      if (!blob) continue;

      if (s.rol === 'video') {
        await this.subirVideoPorPartes(item, s, blob, senal);
      } else {
        const res = await fetchConPlazo(s.url!, {
          method: 'PUT',
          body: blob,
          headers: { 'Content-Type': blob.type || 'image/webp' },
        }, PLAZO_FOTO, senal);
        if (!res.ok) throw new Error(`Fallo al subir ${s.rol} (${res.status})`);
      }
    }
  }

  /**
   * Sube el vídeo en trozos de 5 MB, anotando cada parte terminada en
   * IndexedDB. Si se corta la conexión, al reanudar solo suben las que faltan.
   */
  private async subirVideoPorPartes(
    item: ItemCola, s: SubidaFirmada, blob: Blob, senal?: AbortSignal,
  ): Promise<void> {
    const urls = s.urls ?? [];
    const partSize = s.partSize ?? 0;
    if (!urls.length || !partSize) throw new Error('Firma de vídeo incompleta');

    const hechas = new Map((item.partes ?? []).map((p) => [p.n, p.etag]));

    for (let n = 1; n <= urls.length; n++) {
      if (hechas.has(n)) continue;

      const desde = (n - 1) * partSize;
      const trozo = blob.slice(desde, Math.min(desde + partSize, blob.size));

      const res = await fetchConPlazo(urls[n - 1]!, { method: 'PUT', body: trozo }, PLAZO_PARTE, senal);
      if (!res.ok) throw new Error(`Fallo al subir la parte ${n} del vídeo (${res.status})`);

      // R2 debe exponer ETag por CORS o esto viene vacío y no se puede cerrar
      // el multipart. Ver docs/cloudflare-setup.md.
      const etag = res.headers.get('ETag');
      if (!etag) throw new Error('R2 no devolvió ETag: revisa la política CORS del bucket');

      hechas.set(n, etag);
      item.partes = [...hechas].map(([num, tag]) => ({ n: num, etag: tag }));
      await guardar(item);
    }
  }

  private async completar(item: ItemCola, senal?: AbortSignal): Promise<void> {
    const cuerpo: Record<string, unknown> = {
      id: item.servidorId,
      tipo: item.tipo,
      nombre: item.nombre,
      device_id: item.deviceId,
      key_thumb: item.claves!.thumb,
      key_web: item.tipo === 'foto' ? item.claves!.web : item.claves!.video,
      ancho: item.meta.ancho,
      alto: item.meta.alto,
    };
    if (item.opciones?.origen === 'oficial') {
      cuerpo.origen = 'oficial';
      cuerpo.categoria = item.opciones.categoria ?? null;
    }
    if (item.tipo === 'video') {
      cuerpo.key_poster = item.claves!.poster;
      cuerpo.duracion_s = item.meta.duracion;
      cuerpo.partes = item.partes;
    }

    const res = await fetchConPlazo(`${this.api}/completar`, {
      method: 'POST',
      headers: this.cabeceras(item),
      body: JSON.stringify(cuerpo),
    }, PLAZO_API, senal);
    if (!res.ok) throw new Error(`El servidor rechazó la subida (${res.status})`);
  }
}

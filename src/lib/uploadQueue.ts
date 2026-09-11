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
// De UNA en una. Con tres a la vez, en un 4G saturado las tres se repartían el
// poco ancho de banda, ninguna terminaba a tiempo, se cortaban juntas y volvían
// a empezar desde cero: la barra se quedaba en «0 de 7» indefinidamente. En
// una conexión limitada por ancho de banda, subir en serie tarda lo mismo en
// total y cada foto llega en cuanto termina.
const CONCURRENCIA = 1;
const MAX_INTENTOS = 6;

// fetch NO tiene tiempo de espera por defecto. En un móvil que pierde
// cobertura a media petición, la promesa puede no resolverse NUNCA: la cola se
// queda colgada y ya no la despierta ni volver la conexión. Todo lo que sale a
// la red lleva plazo.
const PLAZO_API = 20_000;      // firmar / completar: son peticiones pequeñas
// Las subidas de bytes no tienen plazo TOTAL, sino de INACTIVIDAD: mientras
// sigan saliendo bytes, da igual que tarden dos minutos. Solo se cortan si
// pasan 45 s sin avanzar nada. Un plazo total cortaba justo las subidas lentas
// pero sanas, que es lo que más hay en una boda.
const PLAZO_ATASCO = 45_000;

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
  fraccion: number;       // 0–1 del total, contando los bytes de lo que sube ahora
  progresoActual?: number; // 0–1 de la foto que está subiendo en este momento
  sinConexion: boolean;   // la cola está parada esperando cobertura
  persistente: boolean;   // false = en memoria: cerrar la pestaña pierde lo pendiente
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

// ── Almacén con plan B en memoria ─────────────────────────────────────
// Safari en navegación privada (y algunos navegadores integrados en apps) NO
// deja guardar archivos en IndexedDB: «Error preparing Blob/File data to be
// stored in object store». Sin plan B, la foto no llegaba ni a encolarse y el
// invitado se quedaba en «Preparando la foto…» para siempre. Si IndexedDB
// falla, la cola sigue en memoria: sube igual, pero no sobrevive a cerrar la
// pestaña (y así se le dice al invitado).
let memoria: Map<string, ItemCola> | null = null;
export const colaPersistente = () => memoria === null;

function pasarAMemoria(err: unknown) {
  if (memoria) return;
  console.warn('IndexedDB no disponible, la cola sigue en memoria:', err);
  memoria = new Map();
}

async function guardar(item: ItemCola): Promise<void> {
  if (!memoria) {
    try { await tx('readwrite', (s) => s.put(item)); return; } catch (e) { pasarAMemoria(e); }
  }
  memoria!.set(item.id, item);
}

async function borrar(id: string): Promise<void> {
  if (!memoria) {
    try { await tx('readwrite', (s) => s.delete(id)); return; } catch (e) { pasarAMemoria(e); }
  }
  memoria!.delete(id);
}

async function leerTodo(): Promise<ItemCola[]> {
  if (!memoria) {
    try { return await tx<ItemCola[]>('readonly', (s) => s.getAll()); } catch (e) { pasarAMemoria(e); }
  }
  return [...memoria!.values()];
}

// ── Utilidades ────────────────────────────────────────────────────────

const esperar = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Se lanza cuando el usuario para la subida a propósito. */
export class Cancelado extends Error {}

/**
 * Error de red: cobertura que se cae, conexión cortada, subida parada.
 * NO cuenta para rendirse. En una boda, un minuto sin cobertura es lo normal:
 * antes, tras 6 fallos seguidos (~1 min) la foto se daba por perdida y la cola
 * dejaba de intentarlo, y el invitado veía que «solo ha subido una».
 */
export class ErrorRed extends Error {}

/** La foto guardada en el móvil ya no se puede leer (fallo conocido de Safari). */
export class DatosPerdidos extends Error {}

// Diagnóstico: el móvil cuenta al servidor qué falló, para poder verlo en
// directo con `wrangler tail`. Como mucho un aviso cada 10 s.
let apiDiag = '';
let ultimoDiag = 0;
function diagnosticar(datos: Record<string, unknown>) {
  if (!apiDiag || Date.now() - ultimoDiag < 10_000) return;
  ultimoDiag = Date.now();
  try {
    navigator.sendBeacon?.(`${apiDiag}/diag`, JSON.stringify({
      ...datos, ua: navigator.userAgent, oculta: document.visibilityState !== 'visible',
      online: navigator.onLine, t: new Date().toISOString(),
    }));
  } catch { /* el diagnóstico nunca puede romper la subida */ }
}

/**
 * PUT con progreso real y plazo por inactividad.
 * Va con XMLHttpRequest porque fetch no informa de cuántos bytes han salido.
 */
function subirConProgreso(
  url: string,
  cuerpo: Blob,
  contentType: string | undefined,
  senal: AbortSignal | undefined,
  alProgreso: (enviados: number) => void,
): Promise<{ status: number; etag: string | null }> {
  return new Promise((resolver, rechazar) => {
    const xhr = new XMLHttpRequest();
    let terminado = false;
    let ultimoAvance = Date.now();
    let enviados = 0;
    const acabar = (fn: () => void) => {
      if (terminado) return;
      terminado = true;
      clearInterval(vigilante);
      senal?.removeEventListener('abort', alCancelar);
      fn();
    };
    const vigilante = setInterval(() => {
      if (Date.now() - ultimoAvance > PLAZO_ATASCO) {
        diagnosticar({ tipo: 'atasco', enviados, total: cuerpo.size });
        acabar(() => rechazar(new ErrorRed('La subida se ha quedado parada. ¿Hay cobertura?')));
        xhr.abort();
      }
    }, 3000);
    const alCancelar = () => {
      acabar(() => rechazar(new Cancelado('Subida cancelada')));
      xhr.abort();
    };
    if (senal?.aborted) { alCancelar(); return; }
    senal?.addEventListener('abort', alCancelar, { once: true });

    xhr.open('PUT', url);
    if (contentType) xhr.setRequestHeader('Content-Type', contentType);
    xhr.upload.onprogress = (e) => { ultimoAvance = Date.now(); enviados = e.loaded; alProgreso(e.loaded); };
    xhr.onload = () => acabar(() => resolver({ status: xhr.status, etag: xhr.getResponseHeader('ETag') }));
    xhr.onerror = () => {
      diagnosticar({ tipo: 'error-red', enviados, total: cuerpo.size, status: xhr.status, readyState: xhr.readyState });
      acabar(() => rechazar(new ErrorRed('Conexión inestable')));
    };
    xhr.send(cuerpo);
  });
}

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
    if (ctrl.signal.aborted) throw new ErrorRed('Se agotó el tiempo de espera. ¿Hay cobertura?');
    throw new ErrorRed(`Sin conexión (${err instanceof Error ? err.message : err})`);
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
  /** Bytes enviados de cada elemento en curso, de 0 a 1. */
  private progreso = new Map<string, number>();
  private avisoProgresoPendiente = false;
  private oyentes: ((r: ResumenCola) => void)[] = [];

  constructor(apiBase: string) {
    this.api = apiBase.replace(/\/$/, '');
    apiDiag = this.api;

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

  /** Avisa del progreso sin saturar: como mucho unas tres veces por segundo. */
  private avisarProgreso() {
    if (this.avisoProgresoPendiente) return;
    this.avisoProgresoPendiente = true;
    setTimeout(() => { this.avisoProgresoPendiente = false; void this.avisar(); }, 300);
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
      fraccion: items.length
        ? (items.filter((i) => i.estado === 'hecho').length
           + items.filter((i) => i.estado === 'subiendo')
               .reduce((acc, i) => acc + (this.progreso.get(i.id) ?? 0), 0)) / items.length
        : 0,
      progresoActual: [...this.progreso.values()][0],
      sinConexion: !navigator.onLine && items.some((i) => i.estado !== 'hecho'),
      persistente: colaPersistente(),
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
    // Se marca el PROPIO objeto, no una copia: firmar() y las partes de vídeo
    // vuelven a guardar `item`, y con una copia devolvían el estado a
    // «pendiente». La interfaz decía «En cola» mientras subía y la barra no
    // contaba los bytes en curso.
    item.estado = 'subiendo';
    item.marcadoEn = Date.now();
    await guardar(item);
    this.trabajando.add(item.id);
    const ctrl = new AbortController();
    this.abortadores.set(item.id, ctrl);
    await this.avisar();

    try {
      // Safari a veces pierde los archivos guardados en IndexedDB: el blob
      // existe pero no se puede leer, y cada intento falla como «error de red».
      // Mejor detectarlo y decirlo que reintentar para siempre.
      for (const blob of Object.values(item.blobs)) {
        try { await blob.slice(0, 16).arrayBuffer(); }
        catch { throw new DatosPerdidos('Esta foto ya no está disponible en el móvil. Vuelve a elegirla.'); }
      }
      if (!item.servidorId) await this.firmar(item, ctrl.signal);
      await this.subirBlobs(item, ctrl.signal);
      await this.completar(item, ctrl.signal);

      // Soltar los blobs: ya están en R2 y ocupan MB en el móvil del invitado.
      await guardar({ ...item, estado: 'hecho', blobs: {}, subidas: undefined });
    } catch (err) {
      // Si lo ha parado el usuario, no se reencola ni se marca como fallo:
      // cancelarTodo() ya se ha llevado el elemento.
      if (this.cancelando || err instanceof Cancelado) return;

      const mensaje = err instanceof Error ? err.message : String(err);
      const esRed = err instanceof ErrorRed || (err instanceof TypeError);
      if (!esRed) diagnosticar({ tipo: 'error', mensaje });

      // Datos perdidos: no tiene arreglo, se dice ya.
      if (err instanceof DatosPerdidos) {
        await guardar({ ...item, estado: 'fallido', intentos: MAX_INTENTOS, error: mensaje });
        return;
      }

      // Los de red se reintentan siempre; solo los demás cuentan para rendirse.
      const intentos = item.intentos + 1;
      const rendirse = !esRed && intentos >= MAX_INTENTOS;

      if (rendirse) {
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
      this.progreso.delete(item.id);
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

    const total = Object.values(item.blobs).reduce((a, b) => a + b.size, 0) || 1;
    let base = 0;
    const informar = (enviados: number) => {
      this.progreso.set(item.id, Math.min(1, (base + enviados) / total));
      this.avisarProgreso();
    };

    for (const s of subidas) {
      const blob = item.blobs[s.rol];
      if (!blob) continue;

      if (s.rol === 'video') {
        await this.subirVideoPorPartes(item, s, blob, senal, (enviadosVideo) => informar(enviadosVideo));
      } else {
        const res = await subirConProgreso(s.url!, blob, blob.type || 'image/webp', senal, informar);
        if (res.status < 200 || res.status >= 300) throw new Error(`Fallo al subir ${s.rol} (${res.status})`);
      }
      base += blob.size;
      informar(0);
    }
  }

  /**
   * Sube el vídeo en trozos de 5 MB, anotando cada parte terminada en
   * IndexedDB. Si se corta la conexión, al reanudar solo suben las que faltan.
   */
  private async subirVideoPorPartes(
    item: ItemCola, s: SubidaFirmada, blob: Blob, senal?: AbortSignal,
    alProgreso: (enviados: number) => void = () => {},
  ): Promise<void> {
    const urls = s.urls ?? [];
    const partSize = s.partSize ?? 0;
    if (!urls.length || !partSize) throw new Error('Firma de vídeo incompleta');

    const hechas = new Map((item.partes ?? []).map((p) => [p.n, p.etag]));

    for (let n = 1; n <= urls.length; n++) {
      if (hechas.has(n)) continue;

      const desde = (n - 1) * partSize;
      const trozo = blob.slice(desde, Math.min(desde + partSize, blob.size));
      const yaSubido = [...hechas.keys()].reduce((a, k) => a + Math.min(partSize, blob.size - (k - 1) * partSize), 0);

      const res = await subirConProgreso(urls[n - 1]!, trozo, undefined, senal, (e) => alProgreso(yaSubido + e));
      if (res.status < 200 || res.status >= 300) throw new Error(`Fallo al subir la parte ${n} del vídeo (${res.status})`);

      // R2 debe exponer ETag por CORS o esto viene vacío y no se puede cerrar
      // el multipart. Ver docs/puesta-en-marcha.md.
      const etag = res.etag;
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

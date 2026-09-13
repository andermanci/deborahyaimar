/**
 * Procesado de fotos y vídeos en el navegador, antes de subir nada.
 *
 * Por qué existe: una foto de móvil son 3-8 MB. Con el 4G saturado de una boda
 * eso es medio minuto por foto y la mitad se quedan a medias. Redimensionando
 * aquí bajamos a ~500 KB (10x más rápido), esquivamos los límites de tamaño y
 * el almacenamiento entra en el tier gratuito de R2.
 *
 * De cada foto salen SIEMPRE dos versiones, y opcionalmente una tercera:
 *   thumb     600 px  — la rejilla; muchas a la vez, tienen que pesar nada
 *   web      3072 px  — el visor a pantalla completa, e imprimible en 20x30
 *   original  tal cual — solo si el invitado elige 'original'; no se muestra
 *                        nunca, está para descargarla
 *
 * El original NO sustituye a la versión web: llega en HEIC (que Chrome y
 * Firefox no saben pintar) y pesa 4 MB, demasiado para un carrusel.
 */

// La calidad depende del formato que sepa generar el navegador.
//
// Safari (todos los iPhone) NO sabe codificar WebP desde un canvas y cae a
// JPEG, que para la misma foto pesa ~3 veces más. Medido con una foto real de
// 13,7 MP en el motor de Safari 26.5: JPEG 3072 @ 85 % = 1,6 MB; en fotos de
// móvil reales, 1,7–2,3 MB. Con eso las subidas se atascaban en la boda.
//
// WebP (Android / Chrome): 3072 px @ 85 % → ~650 KB, 20×30 cm a ~260 ppp.
// JPEG (iPhone):           2560 px @ 80 % → ~1 MB,   20×30 cm a ~215 ppp.
export const MAX_THUMB = 600;
export const CALIDAD_THUMB = 0.75;   // compresión del thumb, no el modo de subida
const AJUSTE = {
  'image/webp': { max: 3072, compresion: 0.85 },
  'image/jpeg': { max: 2560, compresion: 0.80 },
} as const;

// Si pese a todo una foto sale demasiado grande (grano extremo, formato raro),
// se recomprime más fuerte antes de subirla: ninguna foto debe fallar por peso.
const TOPE_WEB = 3.5 * 1024 * 1024;
const REINTENTOS_PESO: [number, number][] = [[2560, 0.72], [2048, 0.7], [1600, 0.68]];

/**
 * Calidad de subida que elige el invitado.
 *   'original' — por defecto: se archiva además el archivo tal cual salió del móvil.
 *   'ligera'   — solo thumb + web. En la galería se ve EXACTAMENTE igual; lo que
 *                se pierde es la copia descargable. Son ~1 MB por foto en vez
 *                de ~5, que es lo que salva una conexión mala.
 */
export type Calidad = 'original' | 'ligera';

/**
 * Tope del original. Cubre cualquier foto de móvil (48 MP en HEIC son ~5 MB,
 * ProRAW ~25 MB) y deja fuera un RAW de réflex enorme, que no es el caso de uso
 * y subiría eternamente.
 */
export const MAX_ORIGINAL = 50 * 1024 * 1024;

/**
 * Lo que se acepta archivar como original. Es una lista cerrada a propósito:
 * el bucket se sirve en un dominio público, así que un archivo que el navegador
 * interpretara como HTML sería un XSS alojado en fotos.deborahyaimar.org.
 */
const TIPOS_ORIGINAL: Record<string, true> = {
  'image/jpeg': true, 'image/png': true, 'image/webp': true,
  'image/heic': true, 'image/heif': true, 'image/avif': true,
  'image/tiff': true, 'image/gif': true,
};
const POR_EXTENSION: Record<string, string> = {
  jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp',
  heic: 'image/heic', heif: 'image/heif', avif: 'image/avif',
  tif: 'image/tiff', tiff: 'image/tiff', gif: 'image/gif',
};

/**
 * El original, con su tipo MIME saneado, o null si no se puede archivar.
 *
 * Algunos selectores de archivos de Android entregan el HEIC con `type` vacío,
 * y el Worker rechaza lo que no lleve un tipo conocido: en ese caso se deduce
 * de la extensión. El Blob resultante comparte los bytes con el File (slice no
 * copia), solo cambia la etiqueta.
 */
function original(archivo: File): Blob | null {
  const declarado = (archivo.type || '').toLowerCase();
  const ext = archivo.name.toLowerCase().match(/\.([a-z0-9]+)$/)?.[1] ?? '';
  const mime = TIPOS_ORIGINAL[declarado] ? declarado : POR_EXTENSION[ext];
  if (!mime) return null;
  if (archivo.size > MAX_ORIGINAL) return null;
  return archivo.slice(0, archivo.size, mime);
}

/**
 * Tope de duración del vídeo.
 *
 * Eran 20 s, pensados para el directo de la boda: con el 4G saturado, un vídeo
 * más largo no llegaba. Ya pasada la boda y subiendo desde casa, 20 s cortan a
 * la gente a media frase; un minuto es lo que dura un brindis, un baile o una
 * entrada.
 */
export const MAX_SEGUNDOS = 60;

/**
 * Tope de peso del vídeo. No se transcodifica nada: sube el archivo tal cual.
 *
 * Un minuto de 1080p son 55 MB en un iPhone y ~120 MB en un Android (que suele
 * grabar en H.264, con más bitrate); 4K30 de iPhone, ~180 MB. Con 250 MB entra
 * todo eso y solo se queda fuera 4K60, que es un ajuste raro y se avisa.
 *
 * Ojo: aquí es donde se va el almacenamiento de verdad. 40 vídeos a este tope
 * son los 10 GB del tramo gratuito enteros; en fotos harían falta 2.000.
 */
export const MAX_VIDEO_BYTES = 250 * 1024 * 1024;

export interface FotoProcesada {
  tipo: 'foto';
  thumb: Blob;
  web: Blob;
  /** El archivo intacto, cuando se pidió 'original' y el formato lo permite. */
  original?: Blob;
  ancho: number;
  alto: number;
}

export interface VideoProcesado {
  tipo: 'video';
  thumb: Blob;      // poster reducido, para la rejilla
  poster: Blob;     // poster a tamaño web, para el reproductor
  video: Blob;      // el original, sin transcodificar
  duracion: number;
  ancho: number;
  alto: number;
}

export type MedioProcesado = FotoProcesada | VideoProcesado;

export class ErrorMedio extends Error {}

/** Muchos navegadores móviles aún fallan al codificar webp; se detecta una vez. */
let soportaWebp: boolean | null = null;
async function formatoSalida(): Promise<'image/webp' | 'image/jpeg'> {
  if (soportaWebp === null) {
    const lienzo = document.createElement('canvas');
    lienzo.width = lienzo.height = 1;
    soportaWebp = lienzo.toDataURL('image/webp').startsWith('data:image/webp');
  }
  return soportaWebp ? 'image/webp' : 'image/jpeg';
}

function escalar(ancho: number, alto: number, max: number) {
  const factor = Math.min(1, max / Math.max(ancho, alto));
  return {
    ancho: Math.max(1, Math.round(ancho * factor)),
    alto: Math.max(1, Math.round(alto * factor)),
  };
}

async function aBlob(lienzo: HTMLCanvasElement, mime: string, compresion: number): Promise<Blob> {
  const blob = await new Promise<Blob | null>((res) => lienzo.toBlob(res, mime, compresion));
  if (!blob) throw new ErrorMedio('No se pudo procesar la imagen.');
  return blob;
}

function pintar(fuente: CanvasImageSource, ancho: number, alto: number): HTMLCanvasElement {
  const lienzo = document.createElement('canvas');
  lienzo.width = ancho;
  lienzo.height = alto;
  const ctx = lienzo.getContext('2d');
  if (!ctx) throw new ErrorMedio('El navegador no permite procesar imágenes.');
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(fuente, 0, 0, ancho, alto);
  return lienzo;
}

// ── Fotos ─────────────────────────────────────────────────────────────

export async function procesarFoto(archivo: File, calidad: Calidad = 'ligera'): Promise<FotoProcesada> {
  let bitmap: ImageBitmap;
  try {
    // `from-image` respeta la orientación EXIF: sin esto las fotos verticales
    // de iPhone se suben giradas.
    bitmap = await createImageBitmap(archivo, { imageOrientation: 'from-image' });
  } catch {
    throw new ErrorMedio('No se pudo leer la foto. ¿Es un formato raro?');
  }

  try {
    const mime = await formatoSalida();
    const { max, compresion } = AJUSTE[mime];
    const dimWeb = escalar(bitmap.width, bitmap.height, max);
    const dimThumb = escalar(bitmap.width, bitmap.height, MAX_THUMB);

    let web = await aBlob(pintar(bitmap, dimWeb.ancho, dimWeb.alto), mime, compresion);
    let dimFinal = dimWeb;
    for (const [max, q] of REINTENTOS_PESO) {
      if (web.size <= TOPE_WEB) break;
      dimFinal = escalar(bitmap.width, bitmap.height, max);
      web = await aBlob(pintar(bitmap, dimFinal.ancho, dimFinal.alto), mime, q);
    }
    const thumb = await aBlob(pintar(bitmap, dimThumb.ancho, dimThumb.alto), mime, CALIDAD_THUMB);

    // Guardar el original solo si aporta algo. Una foto que ya venía pequeña
    // (un reenvío de WhatsApp, una captura) pesa lo mismo o menos que la
    // versión web: archivarla sería pagar almacenamiento por un duplicado y
    // ofrecer una descarga «original» de peor calidad que la que ya se ve.
    const crudo = calidad === 'original' ? original(archivo) : null;
    const vale = crudo !== null && crudo.size > web.size * 1.1;

    return {
      tipo: 'foto', thumb, web,
      original: vale ? crudo! : undefined,
      ancho: dimFinal.ancho, alto: dimFinal.alto,
    };
  } finally {
    bitmap.close();
  }
}

// ── Vídeos ────────────────────────────────────────────────────────────

/** Carga metadatos y extrae un fotograma. El vídeo no se transcodifica. */
export async function procesarVideo(archivo: File): Promise<VideoProcesado> {
  // Lo primero, antes de leer nada: que no se pase medio minuto procesando un
  // vídeo que el servidor va a rechazar de todas formas.
  if (archivo.size > MAX_VIDEO_BYTES) {
    const mb = (n: number) => Math.round(n / 1024 / 1024);
    throw new ErrorMedio(
      `Ese vídeo ocupa ${mb(archivo.size)} MB y el máximo son ${mb(MAX_VIDEO_BYTES)} MB. ` +
      'Recórtalo desde la galería del móvil, o grábalo en 1080p en vez de 4K.'
    );
  }

  const url = URL.createObjectURL(archivo);
  const video = document.createElement('video');
  video.preload = 'metadata';
  video.muted = true;
  // iOS Safari no decodifica vídeo fuera de pantalla sin esto.
  video.playsInline = true;

  try {
    await new Promise<void>((res, rej) => {
      video.onloadedmetadata = () => res();
      video.onerror = () => rej(new ErrorMedio('No se pudo leer el vídeo.'));
      video.src = url;
    });

    const duracion = video.duration;
    if (!Number.isFinite(duracion) || duracion <= 0) {
      throw new ErrorMedio('No se pudo leer la duración del vídeo.');
    }
    if (duracion > MAX_SEGUNDOS) {
      throw new ErrorMedio(
        `El vídeo dura ${Math.round(duracion)} s y el máximo es 1 minuto. ` +
        'Recórtalo desde la galería del móvil y sube el trozo que más te guste.'
      );
    }

    // Fotograma de portada: medio segundo dentro, para no pillar un negro inicial.
    const instante = Math.min(0.5, duracion / 2);
    await new Promise<void>((res, rej) => {
      video.onseeked = () => res();
      video.onerror = () => rej(new ErrorMedio('No se pudo extraer la portada del vídeo.'));
      video.currentTime = instante;
    });

    const ancho = video.videoWidth;
    const alto = video.videoHeight;
    if (!ancho || !alto) throw new ErrorMedio('El vídeo no tiene imagen legible.');

    const mime = await formatoSalida();
    const { max, compresion } = AJUSTE[mime];
    const dimPoster = escalar(ancho, alto, max);
    const dimThumb = escalar(ancho, alto, MAX_THUMB);

    const poster = await aBlob(pintar(video, dimPoster.ancho, dimPoster.alto), mime, compresion);
    const thumb = await aBlob(pintar(video, dimThumb.ancho, dimThumb.alto), mime, CALIDAD_THUMB);

    return {
      tipo: 'video',
      thumb,
      poster,
      video: archivo,
      duracion,
      ancho: dimPoster.ancho,
      alto: dimPoster.alto,
    };
  } finally {
    video.src = '';
    URL.revokeObjectURL(url);
  }
}

/**
 * La calidad solo afecta a las fotos: el vídeo ya se sube sin transcodificar,
 * así que para él 'original' y 'ligera' son exactamente lo mismo.
 */
export async function procesar(archivo: File, calidad: Calidad = 'ligera'): Promise<MedioProcesado> {
  if (archivo.type.startsWith('video/')) return procesarVideo(archivo);
  if (archivo.type.startsWith('image/')) return procesarFoto(archivo, calidad);
  throw new ErrorMedio(`"${archivo.name}" no es una foto ni un vídeo.`);
}

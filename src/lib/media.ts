/**
 * Procesado de fotos y vídeos en el navegador, antes de subir nada.
 *
 * Por qué existe: una foto de móvil son 3-8 MB. Con el 4G saturado de una boda
 * eso es medio minuto por foto y la mitad se quedan a medias. Redimensionando
 * aquí bajamos a ~500 KB (10x más rápido), esquivamos los límites de tamaño y
 * el almacenamiento entra en el tier gratuito de R2.
 */

export const MAX_WEB = 2560;   // suficiente para imprimir en 20x30 cm
export const MAX_THUMB = 600;
export const CALIDAD_WEB = 0.82;
export const CALIDAD_THUMB = 0.75;

/** Tope duro de duración. La UI anuncia 15 s; aceptamos hasta 20 con margen. */
export const MAX_SEGUNDOS = 20;

export interface FotoProcesada {
  tipo: 'foto';
  thumb: Blob;
  web: Blob;
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

async function aBlob(lienzo: HTMLCanvasElement, mime: string, calidad: number): Promise<Blob> {
  const blob = await new Promise<Blob | null>((res) => lienzo.toBlob(res, mime, calidad));
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

export async function procesarFoto(archivo: File): Promise<FotoProcesada> {
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
    const dimWeb = escalar(bitmap.width, bitmap.height, MAX_WEB);
    const dimThumb = escalar(bitmap.width, bitmap.height, MAX_THUMB);

    const web = await aBlob(pintar(bitmap, dimWeb.ancho, dimWeb.alto), mime, CALIDAD_WEB);
    const thumb = await aBlob(pintar(bitmap, dimThumb.ancho, dimThumb.alto), mime, CALIDAD_THUMB);

    return { tipo: 'foto', thumb, web, ancho: dimWeb.ancho, alto: dimWeb.alto };
  } finally {
    bitmap.close();
  }
}

// ── Vídeos ────────────────────────────────────────────────────────────

/** Carga metadatos y extrae un fotograma. El vídeo no se transcodifica. */
export async function procesarVideo(archivo: File): Promise<VideoProcesado> {
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
        `El vídeo dura ${Math.round(duracion)} s y el máximo son ${MAX_SEGUNDOS}. ` +
        'Graba uno más corto o recórtalo desde la galería del móvil.'
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
    const dimPoster = escalar(ancho, alto, MAX_WEB);
    const dimThumb = escalar(ancho, alto, MAX_THUMB);

    const poster = await aBlob(pintar(video, dimPoster.ancho, dimPoster.alto), mime, CALIDAD_WEB);
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

export async function procesar(archivo: File): Promise<MedioProcesado> {
  if (archivo.type.startsWith('video/')) return procesarVideo(archivo);
  if (archivo.type.startsWith('image/')) return procesarFoto(archivo);
  throw new ErrorMedio(`"${archivo.name}" no es una foto ni un vídeo.`);
}

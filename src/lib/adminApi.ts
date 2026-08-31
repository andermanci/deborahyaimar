/**
 * Cliente del panel de los novios.
 *
 * La contraseña viaja en la cabecera X-Admin-Password, no en el cuerpo: así
 * también sirve para peticiones GET. Sobre HTTPS es correcto; si algún día se
 * quiere endurecer, el paso siguiente sería un token firmado con caducidad.
 */

const PLAZO = 30_000;

export class NoAutorizado extends Error {}
export class ErrorApi extends Error {}

export interface MediaAdmin {
  id: string;
  tipo: 'foto' | 'video';
  origen: 'invitado' | 'oficial';
  categoria: string | null;
  nombre: string;
  oculta: boolean;
  thumb: string;
  web: string;
  poster: string | null;
  duracion: number | null;
  ancho: number;
  alto: number;
  ts: number;
}

export interface Estadisticas {
  total: number; visibles: number; ocultas: number;
  fotos: number; videos: number;
  invitados: number; oficiales: number;
  personas: number;
  ranking: { nombre: string; n: number }[];
  porHora: { hora: string; n: number }[];
  almacenamiento: { bytes: number; objetos: number; limiteBytes: number };
}

export class AdminApi {
  constructor(private base: string, private password: string) {
    this.base = base.replace(/\/$/, '');
  }

  private async pedir<T>(ruta: string, opciones: RequestInit = {}): Promise<T> {
    const ctrl = new AbortController();
    const reloj = setTimeout(() => ctrl.abort(), PLAZO);
    let res: Response;
    try {
      res = await fetch(`${this.base}${ruta}`, {
        ...opciones,
        signal: ctrl.signal,
        cache: 'no-store',
        headers: {
          ...(opciones.body ? { 'Content-Type': 'application/json' } : {}),
          'X-Admin-Password': this.password,
          ...(opciones.headers ?? {}),
        },
      });
    } catch {
      throw new ErrorApi(ctrl.signal.aborted ? 'El servidor no responde.' : 'Sin conexión.');
    } finally {
      clearTimeout(reloj);
    }

    if (res.status === 401) throw new NoAutorizado('Contraseña incorrecta.');
    if (!res.ok) {
      const cuerpo = await res.json().catch(() => ({} as any));
      throw new ErrorApi(cuerpo?.error ?? `Error ${res.status}`);
    }
    return res.json() as Promise<T>;
  }

  login() {
    return this.pedir<{ ok: true }>('/admin/login', { method: 'POST' });
  }

  media(filtros: { origen?: string; estado?: string } = {}) {
    const q = new URLSearchParams();
    if (filtros.origen) q.set('origen', filtros.origen);
    if (filtros.estado) q.set('estado', filtros.estado);
    const cola = q.toString();
    return this.pedir<{ items: MediaAdmin[]; total: number }>(`/admin/media${cola ? '?' + cola : ''}`);
  }

  stats() {
    return this.pedir<Estadisticas>('/admin/stats');
  }

  ocultar(ids: string[], oculta: boolean) {
    return this.pedir<{ afectados: number }>('/admin/ocultar', {
      method: 'POST', body: JSON.stringify({ ids, oculta }),
    });
  }

  /** DEFINITIVO: se lleva los bytes de R2. Solo desde la papelera. */
  eliminar(ids: string[]) {
    return this.pedir<{ borrados: number; objetos: number }>('/admin/eliminar', {
      method: 'POST', body: JSON.stringify({ ids }),
    });
  }

  categoria(ids: string[], categoria: string | null) {
    return this.pedir<{ afectados: number }>('/admin/categoria', {
      method: 'POST', body: JSON.stringify({ ids, categoria }),
    });
  }

  limpiarParciales() {
    return this.pedir<{ limpiadas: number }>('/admin/limpiar-parciales', { method: 'POST' });
  }
}

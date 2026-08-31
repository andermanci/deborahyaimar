/**
 * Cliente del panel de los novios.
 *
 * La contraseña se manda UNA vez al entrar; a partir de ahí viaja un token
 * firmado con caducidad, que es lo único que se guarda en el navegador.
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

export interface Categoria {
  slug: string;
  nombre: string;
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

export interface Sesion {
  token: string;
  expira: number;
  usuario: string;
}

export class AdminApi {
  private token = '';

  constructor(private base: string) {
    this.base = base.replace(/\/$/, '');
  }

  usarToken(token: string) { this.token = token; }

  /** Cambia usuario y contraseña por una sesión. Es la única vez que viaja la clave. */
  async entrar(usuario: string, password: string): Promise<Sesion> {
    const res = await fetch(`${this.base}/admin/login`, {
      method: 'POST',
      cache: 'no-store',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ usuario, password }),
    }).catch(() => null);

    if (!res) throw new ErrorApi('Sin conexión.');
    if (res.status === 401) throw new NoAutorizado('Usuario o contraseña incorrectos.');
    if (!res.ok) {
      const c = await res.json().catch(() => ({} as any));
      throw new ErrorApi(c?.error ?? `Error ${res.status}`);
    }
    const datos = await res.json() as Sesion;
    this.token = datos.token;
    return datos;
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
          Authorization: `Bearer ${this.token}`,
          ...(opciones.headers ?? {}),
        },
      });
    } catch {
      throw new ErrorApi(ctrl.signal.aborted ? 'El servidor no responde.' : 'Sin conexión.');
    } finally {
      clearTimeout(reloj);
    }

    if (res.status === 401) throw new NoAutorizado('La sesión ha caducado.');
    if (!res.ok) {
      const cuerpo = await res.json().catch(() => ({} as any));
      throw new ErrorApi(cuerpo?.error ?? `Error ${res.status}`);
    }
    return res.json() as Promise<T>;
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

  categorias() {
    return this.pedir<{ categorias: Categoria[] }>('/categorias.json');
  }

  crearCategoria(nombre: string) {
    return this.pedir<{ slug: string; nombre: string }>('/admin/categorias', {
      method: 'POST', body: JSON.stringify({ nombre }),
    });
  }

  /** No borra fotos: las que hubiera dentro se quedan sin categoría. */
  borrarCategoria(slug: string) {
    return this.pedir<{ fotosSinCategoria: number }>('/admin/categorias/borrar', {
      method: 'POST', body: JSON.stringify({ slug }),
    });
  }

  limpiarParciales() {
    return this.pedir<{ limpiadas: number }>('/admin/limpiar-parciales', { method: 'POST' });
  }
}

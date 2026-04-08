/**
 * Netlify Function: fotos-invitados
 * Lista las fotos subidas por invitados desde Cloudinary.
 *
 * Variables de entorno necesarias en Netlify → Site configuration → Environment variables:
 *   CLOUDINARY_CLOUD_NAME   → tu cloud name (ej. "dxyz1234")
 *   CLOUDINARY_API_KEY      → API Key de la cuenta Cloudinary
 *   CLOUDINARY_API_SECRET   → API Secret de la cuenta Cloudinary
 */

export const handler = async () => {
  const cloudName = process.env.CLOUDINARY_CLOUD_NAME;
  const apiKey    = process.env.CLOUDINARY_API_KEY;
  const apiSecret = process.env.CLOUDINARY_API_SECRET;
  const folder    = 'wedding/invitados';

  if (!cloudName || !apiKey || !apiSecret) {
    return {
      statusCode: 500,
      body: JSON.stringify({ error: 'Cloudinary env vars not set' }),
    };
  }

  try {
    const auth = Buffer.from(`${apiKey}:${apiSecret}`).toString('base64');
    const url  = `https://api.cloudinary.com/v1_1/${cloudName}/resources/image`
      + `?type=upload&prefix=${encodeURIComponent(folder)}&max_results=200&context=true`;

    const res  = await fetch(url, { headers: { Authorization: `Basic ${auth}` } });
    const data = await res.json();

    const fotos = (data.resources ?? [])
      .sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime())
      .map(r => ({
        thumb : `https://res.cloudinary.com/${cloudName}/image/upload/c_fill,w_480,h_480,q_auto,f_auto/${r.public_id}`,
        full  : `https://res.cloudinary.com/${cloudName}/image/upload/q_auto,f_auto/${r.public_id}`,
        nombre: r.context?.custom?.nombre ?? '',
        fecha : r.created_at,
      }));

    return {
      statusCode: 200,
      headers: {
        'Content-Type': 'application/json',
        'Cache-Control': 'no-store',
      },
      body: JSON.stringify(fotos),
    };
  } catch (err) {
    return { statusCode: 500, body: JSON.stringify({ error: String(err) }) };
  }
};

-- Índice de la galería. Los bytes viven en R2; aquí solo van los metadatos.
-- Aplicar con:  wrangler d1 execute ad-galeria --remote --file=schema.sql

create table if not exists media (
  id            text primary key,          -- uuid generado en el Worker
  tipo          text not null check (tipo in ('foto', 'video')),
  origen        text not null check (origen in ('invitado', 'oficial')),
  categoria     text,                      -- ceremonia|cocktail|comida|baile|momentos (solo 'oficial')
  nombre        text,                      -- quién la subió
  device_id     text,                      -- permite "borrar la mía" sin cuentas
  key_thumb     text not null,             -- 600px  webp ~60KB
  key_web       text not null,             -- 2560px webp ~500KB  (en vídeo: el .mp4)
  key_original  text,                      -- solo 'oficial'
  key_poster    text,                      -- solo 'video'
  duracion_s    real,
  ancho         integer,
  alto          integer,
  oculta        integer not null default 0,
  created_at    integer not null           -- epoch ms
);

-- Sirve la consulta del índice: where oculta = 0 order by created_at desc
create index if not exists media_visible_idx on media (oculta, created_at desc);

-- Subidas de vídeo a medias: se limpian solas si nunca se completan.
-- Guarda el uploadId de S3 para poder reanudar tras cerrar la pestaña.
create table if not exists subidas_parciales (
  id          text primary key,
  key         text not null,
  upload_id   text not null,
  created_at  integer not null
);

-- The e2e suite's database: a blog in public, a shop in its own schema.
DROP SCHEMA IF EXISTS shop CASCADE;
DROP TABLE IF EXISTS public.comments, public.posts, public.users CASCADE;
DROP MATERIALIZED VIEW IF EXISTS public.post_counts;

CREATE TABLE public.users (
  id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  email text NOT NULL UNIQUE,
  name text NOT NULL,
  joined timestamptz NOT NULL DEFAULT '2026-01-01 09:00:00+00',
  admin boolean NOT NULL DEFAULT false
);
COMMENT ON TABLE public.users IS 'People who write';

CREATE TABLE public.posts (
  id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  author integer NOT NULL REFERENCES public.users (id),
  title text NOT NULL,
  body text,
  views bigint NOT NULL DEFAULT 0 CHECK (views >= 0),
  meta jsonb
);
CREATE INDEX posts_author ON public.posts (author);

CREATE TABLE public.comments (
  id serial PRIMARY KEY,
  post integer NOT NULL REFERENCES public.posts (id),
  body text NOT NULL
);

INSERT INTO public.users (email, name, admin)
SELECT 'user' || n || '@example.com', 'User ' || n, n = 1 FROM generate_series(1, 40) n;

INSERT INTO public.posts (author, title, body, views, meta)
SELECT 1 + n % 40, 'Post number ' || n, 'Line one of post ' || n || E'\nLine two',
       n * 7, CASE WHEN n % 10 = 0 THEN jsonb_build_object('featured', true, 'n', n) END
FROM generate_series(1, 1500) n;

INSERT INTO public.comments (post, body) SELECT 1 + n % 1500, 'Comment ' || n FROM generate_series(1, 300) n;

CREATE VIEW public.admins AS SELECT id, email FROM public.users WHERE admin;
CREATE MATERIALIZED VIEW public.post_counts AS SELECT author, count(*) AS posts FROM public.posts GROUP BY author;

CREATE SCHEMA shop;
CREATE TABLE shop.products (id serial PRIMARY KEY, name text NOT NULL, price numeric(10,2) NOT NULL);
INSERT INTO shop.products (name, price) VALUES ('Pen', 1.50), ('Book', 12.00), ('Lamp', 30.25);

ANALYZE;

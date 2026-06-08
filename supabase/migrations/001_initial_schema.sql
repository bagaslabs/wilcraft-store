create extension if not exists pgcrypto;

-- ── Tables ──────────────────────────────────────────────

create table if not exists public.users (
  discord_id text primary key,
  grow_id text,
  balance_locks bigint not null default 0 check (balance_locks >= 0),
  total_deposit_idr bigint not null default 0 check (total_deposit_idr >= 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.products (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  code text not null,
  price_locks bigint not null check (price_locks >= 0),
  price_idr bigint check (price_idr is null or price_idr >= 0),
  description text not null default '',
  total_sold bigint not null default 0 check (total_sold >= 0),
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index if not exists products_code_upper_idx
  on public.products (upper(code));

create table if not exists public.orders (
  id uuid primary key default gen_random_uuid(),
  buyer_discord_id text not null references public.users(discord_id),
  product_id uuid not null references public.products(id),
  quantity integer not null check (quantity > 0),
  total_price_locks bigint not null check (total_price_locks >= 0),
  delivered_items text[] not null,
  order_number bigint not null,
  created_at timestamptz not null default now()
);

create sequence if not exists public.orders_order_number_seq;

alter table public.orders
  add column if not exists order_number bigint;

alter table public.orders
  alter column order_number set default nextval('public.orders_order_number_seq'::regclass);

alter sequence public.orders_order_number_seq
  owned by public.orders.order_number;

do $$
declare
  v_max_order_number bigint;
begin
  select coalesce(max(order_number), 0)
  into v_max_order_number
  from public.orders;

  if v_max_order_number > 0 then
    perform setval('public.orders_order_number_seq', v_max_order_number, true);
  end if;
end;
$$;

alter table public.orders
  alter column order_number set not null;

create unique index if not exists orders_order_number_idx
  on public.orders (order_number);

create table if not exists public.stock_items (
  id uuid primary key default gen_random_uuid(),
  product_id uuid not null references public.products(id) on delete cascade,
  content text not null check (length(trim(content)) > 0),
  status text not null default 'available'
    check (status in ('available', 'sold')),
  sold_to text references public.users(discord_id),
  sold_at timestamptz,
  order_id uuid references public.orders(id),
  created_at timestamptz not null default now(),
  unique (product_id, content)
);

create index if not exists stock_items_available_idx
  on public.stock_items (product_id, created_at)
  where status = 'available';

create table if not exists public.transactions (
  id uuid primary key default gen_random_uuid(),
  user_id text not null references public.users(discord_id),
  type text not null check (type in ('topup', 'purchase')),
  amount_idr bigint not null default 0,
  fee_idr bigint not null default 0,
  gross_amount_idr bigint not null default 0,
  amount_locks bigint not null,
  status text not null
    check (status in ('pending', 'settlement', 'failed', 'expired', 'cancelled')),
  midtrans_order_id text unique,
  midtrans_transaction_id text,
  qr_url text,
  expires_at timestamptz,
  raw_payload jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.settings (
  key text primary key,
  value jsonb not null,
  updated_at timestamptz not null default now()
);

-- ── Seed data ───────────────────────────────────────────

insert into public.settings (key, value)
values
  ('qris_rate_idr_per_dl', '5000'::jsonb),
  ('dl_rate_idr_per_dl', '5000'::jsonb),
  (
    'deposit_world',
    '{"world":"OVERSTORE","owner":"CHANGE_ME","bot_name":"CHANGE_ME","note":"Jangan donasi jika bot yang berada di world bukan bot resmi toko."}'::jsonb
  )
on conflict (key) do nothing;

-- ── Live products view ──────────────────────────────────

create or replace view public.live_products
with (security_invoker = true)
as
select
  p.id,
  p.name,
  p.code,
  p.price_locks,
  p.price_idr,
  p.description,
  p.total_sold,
  p.active,
  count(s.id) filter (where s.status = 'available')::bigint as available_stock
from public.products p
left join public.stock_items s on s.product_id = p.id
group by p.id;

-- ── Functions ───────────────────────────────────────────

create or replace function public.purchase_product(
  p_discord_id text,
  p_product_code text,
  p_quantity integer
)
returns table (
  order_id text,
  product_name text,
  product_code text,
  unit_price_locks bigint,
  quantity integer,
  total_price_locks bigint,
  balance_locks bigint,
  created_at timestamptz,
  delivered_items text[]
)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user public.users%rowtype;
  v_product public.products%rowtype;
  v_stock_ids uuid[];
  v_stock_contents text[];
  v_order_uuid uuid;
  v_order_number bigint;
  v_order_created_at timestamptz;
  v_total bigint;
  v_unit_price bigint;
  v_balance bigint;
begin
  if p_quantity is null or p_quantity < 1 or p_quantity > 100 then
    raise exception 'Jumlah pembelian harus antara 1 dan 100';
  end if;

  select *
  into v_user
  from public.users as u
  where u.discord_id = p_discord_id
  for update;

  if not found or v_user.grow_id is null then
    raise exception 'GrowID belum diatur';
  end if;

  select *
  into v_product
  from public.products as p
  where upper(p.code) = upper(trim(p_product_code))
    and p.active = true
  for update;

  if not found then
    raise exception 'Kode produk tidak ditemukan';
  end if;

  v_total := v_product.price_locks * p_quantity;
  v_unit_price := v_product.price_locks;

  if v_user.balance_locks < v_total then
    raise exception 'Saldo tidak mencukupi';
  end if;

  select
    array_agg(selected.id order by selected.created_at, selected.id),
    array_agg(selected.content order by selected.created_at, selected.id)
  into v_stock_ids, v_stock_contents
  from (
    select si.id, si.content, si.created_at
    from public.stock_items as si
    where si.product_id = v_product.id
      and si.status = 'available'
    order by si.created_at, si.id
    for update skip locked
    limit p_quantity
  ) selected;

  if coalesce(cardinality(v_stock_ids), 0) <> p_quantity then
    raise exception 'Stok produk tidak mencukupi';
  end if;

  insert into public.orders as o (
    buyer_discord_id,
    product_id,
    quantity,
    total_price_locks,
    delivered_items
  )
  values (
    p_discord_id,
    v_product.id,
    p_quantity,
    v_total,
    v_stock_contents
  )
  returning o.id, o.order_number, o.created_at
  into v_order_uuid, v_order_number, v_order_created_at;

  update public.stock_items as si
  set
    status = 'sold',
    sold_to = p_discord_id,
    sold_at = now(),
    order_id = v_order_uuid
  where si.id = any(v_stock_ids);

  update public.users as u
  set
    balance_locks = u.balance_locks - v_total,
    updated_at = now()
  where u.discord_id = p_discord_id
  returning u.balance_locks into v_balance;

  update public.products as p
  set
    total_sold = p.total_sold + p_quantity,
    updated_at = now()
  where p.id = v_product.id;

  insert into public.transactions (
    user_id,
    type,
    amount_locks,
    status,
    raw_payload
  )
  values (
    p_discord_id,
    'purchase',
    -v_total,
    'settlement',
    jsonb_build_object(
      'order_id', v_order_uuid,
      'order_number', v_order_number
    )
  );

  return query
  select
    v_order_number::text,
    v_product.name,
    v_product.code,
    v_unit_price,
    p_quantity,
    v_total,
    v_balance,
    v_order_created_at,
    v_stock_contents;
end;
$$;

create or replace function public.settle_topup(
  p_order_id text,
  p_midtrans_transaction_id text,
  p_transaction_status text,
  p_gross_amount bigint,
  p_raw_payload jsonb default '{}'::jsonb,
  p_force boolean default false
)
returns table (
  transaction_id uuid,
  discord_id text,
  amount_idr bigint,
  credited_locks bigint,
  balance_locks bigint,
  already_credited boolean
)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_transaction public.transactions%rowtype;
  v_balance bigint;
begin
  select t.*
  into v_transaction
  from public.transactions as t
  where t.midtrans_order_id = p_order_id
    and t.type = 'topup'
  for update;

  if not found then
    raise exception 'Transaksi top-up tidak ditemukan';
  end if;

  if v_transaction.gross_amount_idr <> p_gross_amount then
    raise exception 'Nominal transaksi tidak cocok';
  end if;

  if v_transaction.status = 'settlement' then
    select u.balance_locks
    into v_balance
    from public.users u
    where u.discord_id = v_transaction.user_id;

    return query
    select
      v_transaction.id,
      v_transaction.user_id,
      v_transaction.amount_idr,
      v_transaction.amount_locks,
      v_balance,
      true;
    return;
  end if;

  if not p_force and lower(p_transaction_status) not in ('settlement', 'capture') then
    raise exception 'Status pembayaran belum berhasil';
  end if;

  update public.transactions as t
  set
    status = 'settlement',
    midtrans_transaction_id = p_midtrans_transaction_id,
    raw_payload = p_raw_payload,
    updated_at = now()
  where t.id = v_transaction.id;

  insert into public.users as u (
    discord_id,
    balance_locks,
    total_deposit_idr
  )
  values (
    v_transaction.user_id,
    v_transaction.amount_locks,
    v_transaction.amount_idr
  )
  on conflict on constraint users_pkey do update
  set
    balance_locks = u.balance_locks + excluded.balance_locks,
    total_deposit_idr = u.total_deposit_idr + excluded.total_deposit_idr,
    updated_at = now()
  returning u.balance_locks into v_balance;

  return query
  select
    v_transaction.id,
    v_transaction.user_id,
    v_transaction.amount_idr,
    v_transaction.amount_locks,
    v_balance,
    false;
end;
$$;

-- ── Row-level security ──────────────────────────────────

alter table public.users enable row level security;
alter table public.products enable row level security;
alter table public.stock_items enable row level security;
alter table public.orders enable row level security;
alter table public.transactions enable row level security;
alter table public.settings enable row level security;

-- ── Permissions ─────────────────────────────────────────

revoke all on function public.purchase_product(text, text, integer)
  from public, anon, authenticated;
revoke all on function public.settle_topup(text, text, text, bigint, jsonb, boolean)
  from public, anon, authenticated;
grant execute on function public.purchase_product(text, text, integer)
  to service_role;
grant execute on function public.settle_topup(text, text, text, bigint, jsonb, boolean)
  to service_role;

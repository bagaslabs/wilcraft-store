create sequence if not exists public.orders_order_number_seq;

alter table public.orders
  add column if not exists order_number bigint;

with numbered_orders as (
  select
    id,
    row_number() over (order by created_at, id)::bigint as generated_order_number
  from public.orders
  where order_number is null
)
update public.orders as o
set order_number = numbered_orders.generated_order_number
from numbered_orders
where o.id = numbered_orders.id;

do $$
declare
  v_max_order_number bigint;
begin
  select coalesce(max(order_number), 0)
  into v_max_order_number
  from public.orders;

  if v_max_order_number > 0 then
    perform setval('public.orders_order_number_seq', v_max_order_number, true);
  else
    perform setval('public.orders_order_number_seq', 1, false);
  end if;
end;
$$;

alter sequence public.orders_order_number_seq
  owned by public.orders.order_number;

alter table public.orders
  alter column order_number set default nextval('public.orders_order_number_seq'::regclass),
  alter column order_number set not null;

create unique index if not exists orders_order_number_idx
  on public.orders (order_number);

drop function if exists public.purchase_product(text, text, integer);

create function public.purchase_product(
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

revoke all on function public.purchase_product(text, text, integer)
  from public, anon, authenticated;
grant execute on function public.purchase_product(text, text, integer)
  to service_role;

notify pgrst, 'reload schema';

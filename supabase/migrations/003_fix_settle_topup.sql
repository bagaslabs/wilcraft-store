drop function if exists public.settle_topup(
  text,
  text,
  text,
  bigint,
  jsonb,
  boolean
);

create function public.settle_topup(
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
    from public.users as u
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

revoke all on function public.settle_topup(
  text,
  text,
  text,
  bigint,
  jsonb,
  boolean
) from public, anon, authenticated;

grant execute on function public.settle_topup(
  text,
  text,
  text,
  bigint,
  jsonb,
  boolean
) to service_role;

notify pgrst, 'reload schema';

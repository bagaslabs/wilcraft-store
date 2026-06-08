import { randomUUID } from "node:crypto";

import type { DatabaseClient } from "../database";
import type {
  LiveProduct,
  Product,
  ProductInput,
  ProductUpdate,
  PurchaseResult,
  SettlementResult,
  StoreSettings,
  TopupInput,
  Transaction,
  UserAccount,
} from "../types";

function normalizeCode(code: string): string {
  return code.trim().toUpperCase();
}

function throwIfError(error: { message: string } | null): void {
  if (error) throw new Error(error.message);
}

export class StoreRepository {
  constructor(private readonly database: DatabaseClient) {}

  async listLiveProducts(): Promise<LiveProduct[]> {
    const { data, error } = await this.database
      .from("live_products")
      .select("*")
      .eq("active", true)
      .order("name");
    throwIfError(error);
    return (data ?? []) as LiveProduct[];
  }

  async getProductByCode(code: string): Promise<Product | null> {
    const { data, error } = await this.database
      .from("products")
      .select("*")
      .ilike("code", normalizeCode(code))
      .maybeSingle();
    throwIfError(error);
    return data as Product | null;
  }

  async createProduct(input: ProductInput): Promise<Product> {
    const { data, error } = await this.database
      .from("products")
      .insert({
        name: input.name.trim(),
        code: normalizeCode(input.code),
        price_locks: input.priceLocks,
        price_idr: input.priceIdr ?? null,
        description: input.description?.trim() ?? "",
      })
      .select("*")
      .single();
    throwIfError(error);
    return data as Product;
  }

  async updateProduct(code: string, input: ProductUpdate): Promise<Product> {
    const values: Record<string, string | number | boolean | null> = {
      updated_at: new Date().toISOString(),
    };
    if (input.name !== undefined) values.name = input.name.trim();
    if (input.code !== undefined) values.code = normalizeCode(input.code);
    if (input.priceLocks !== undefined) values.price_locks = input.priceLocks;
    if (input.priceIdr !== undefined) values.price_idr = input.priceIdr;
    if (input.description !== undefined) {
      values.description = input.description.trim();
    }
    if (input.active !== undefined) values.active = input.active;

    const { data, error } = await this.database
      .from("products")
      .update(values)
      .ilike("code", normalizeCode(code))
      .select("*")
      .single();
    throwIfError(error);
    return data as Product;
  }

  async deactivateProduct(code: string): Promise<Product> {
    return this.updateProduct(code, { active: false });
  }

  async addStock(code: string, items: string[]): Promise<number> {
    const product = await this.getProductByCode(code);
    if (!product) throw new Error("Kode produk tidak ditemukan");

    let inserted = 0;
    for (let index = 0; index < items.length; index += 500) {
      const chunk = items.slice(index, index + 500);
      const { data, error } = await this.database
        .from("stock_items")
        .upsert(
          chunk.map((content) => ({
            product_id: product.id,
            content,
          })),
          {
            onConflict: "product_id,content",
            ignoreDuplicates: true,
          },
        )
        .select("id");
      throwIfError(error);
      inserted += data?.length ?? 0;
    }

    return inserted;
  }

  async getStockCount(code: string): Promise<{
    product: Product;
    available: number;
    sold: number;
  }> {
    const product = await this.getProductByCode(code);
    if (!product) throw new Error("Kode produk tidak ditemukan");

    const [availableResult, soldResult] = await Promise.all([
      this.database
        .from("stock_items")
        .select("*", { count: "exact", head: true })
        .eq("product_id", product.id)
        .eq("status", "available"),
      this.database
        .from("stock_items")
        .select("*", { count: "exact", head: true })
        .eq("product_id", product.id)
        .eq("status", "sold"),
    ]);
    throwIfError(availableResult.error);
    throwIfError(soldResult.error);

    return {
      product,
      available: availableResult.count ?? 0,
      sold: soldResult.count ?? 0,
    };
  }

  async setGrowId(discordId: string, growId: string): Promise<UserAccount> {
    const { data, error } = await this.database
      .from("users")
      .upsert(
        {
          discord_id: discordId,
          grow_id: growId.trim(),
          updated_at: new Date().toISOString(),
        },
        { onConflict: "discord_id" },
      )
      .select("discord_id,grow_id,balance_locks,total_deposit_idr")
      .single();
    throwIfError(error);
    return data as UserAccount;
  }

  async ensureUser(discordId: string): Promise<void> {
    const { error } = await this.database
      .from("users")
      .upsert({ discord_id: discordId }, { onConflict: "discord_id" });
    throwIfError(error);
  }

  async getUser(discordId: string): Promise<UserAccount | null> {
    const { data, error } = await this.database
      .from("users")
      .select("discord_id,grow_id,balance_locks,total_deposit_idr")
      .eq("discord_id", discordId)
      .maybeSingle();
    throwIfError(error);
    return data as UserAccount | null;
  }

  async purchase(
    discordId: string,
    productCode: string,
    quantity: number,
  ): Promise<PurchaseResult> {
    const { data, error } = await this.database.rpc("purchase_product", {
      p_discord_id: discordId,
      p_product_code: normalizeCode(productCode),
      p_quantity: quantity,
    });
    throwIfError(error);
    const result = (data as PurchaseResult[] | null)?.[0];
    if (!result) throw new Error("Pembelian gagal diproses");
    return result;
  }

  async getSetting<T>(key: string): Promise<T> {
    const { data, error } = await this.database
      .from("settings")
      .select("value")
      .eq("key", key)
      .single();
    throwIfError(error);
    if (!data) throw new Error(`Setting ${key} tidak ditemukan`);
    return data.value as T;
  }

  async setSetting(key: string, value: unknown): Promise<void> {
    const { error } = await this.database.from("settings").upsert(
      {
        key,
        value,
        updated_at: new Date().toISOString(),
      },
      { onConflict: "key" },
    );
    throwIfError(error);
  }

  async addBalance(input: {
    discordId: string;
    deltaLocks: number;
    deltaIdr: number;
    note?: string;
    actorDiscordId: string;
  }): Promise<UserAccount> {
    await this.ensureUser(input.discordId);
    const current = await this.getUser(input.discordId);
    if (!current) {
      throw new Error("User tidak ditemukan");
    }

    const updatedBalance = current.balance_locks + input.deltaLocks;
    const updatedDeposit = current.total_deposit_idr + input.deltaIdr;

    const { data, error } = await this.database
      .from("users")
      .update({
        balance_locks: updatedBalance,
        total_deposit_idr: updatedDeposit,
        updated_at: new Date().toISOString(),
      })
      .eq("discord_id", input.discordId)
      .select("discord_id,grow_id,balance_locks,total_deposit_idr")
      .single();
    throwIfError(error);

    const { error: transactionError } = await this.database.from("transactions").insert({
      user_id: input.discordId,
      type: "topup",
      amount_idr: input.deltaIdr,
      fee_idr: 0,
      gross_amount_idr: input.deltaIdr,
      amount_locks: input.deltaLocks,
      status: "settlement",
      midtrans_order_id: `MANUAL-${input.discordId}-${Date.now()}-${randomUUID()}`,
      raw_payload: {
        source: "manual_add_balance",
        note: input.note ?? "",
        actor_discord_id: input.actorDiscordId,
        amount_locks: input.deltaLocks,
        amount_idr: input.deltaIdr,
      },
    });
    throwIfError(transactionError);

    return data as UserAccount;
  }

  async removeBalance(input: {
    discordId: string;
    deltaLocks: number;
    deltaIdr: number;
    note?: string;
    actorDiscordId: string;
  }): Promise<UserAccount> {
    await this.ensureUser(input.discordId);
    const current = await this.getUser(input.discordId);
    if (!current) {
      throw new Error("User tidak ditemukan");
    }
    if (input.deltaLocks <= 0) {
      throw new Error("Kurangi minimal 1 bgl, dl, atau wl");
    }
    if (current.balance_locks < input.deltaLocks) {
      throw new Error("Saldo user tidak mencukupi untuk dikurangi");
    }

    const updatedBalance = current.balance_locks - input.deltaLocks;
    const { data, error } = await this.database
      .from("users")
      .update({
        balance_locks: updatedBalance,
        updated_at: new Date().toISOString(),
      })
      .eq("discord_id", input.discordId)
      .select("discord_id,grow_id,balance_locks,total_deposit_idr")
      .single();
    throwIfError(error);

    const { error: transactionError } = await this.database.from("transactions").insert({
      user_id: input.discordId,
      type: "purchase",
      amount_idr: -input.deltaIdr,
      fee_idr: 0,
      gross_amount_idr: -input.deltaIdr,
      amount_locks: -input.deltaLocks,
      status: "settlement",
      midtrans_order_id: `MANUAL-REMOVE-${input.discordId}-${Date.now()}-${randomUUID()}`,
      raw_payload: {
        source: "manual_remove_balance",
        note: input.note ?? "",
        actor_discord_id: input.actorDiscordId,
        amount_locks: -input.deltaLocks,
        amount_idr: -input.deltaIdr,
        previous_balance_locks: current.balance_locks,
        new_balance_locks: updatedBalance,
      },
    });
    throwIfError(transactionError);

    return data as UserAccount;
  }

  async setBalance(input: {
    discordId: string;
    balanceLocks: number;
    deltaIdr: number;
    note?: string;
    actorDiscordId: string;
  }): Promise<UserAccount> {
    await this.ensureUser(input.discordId);
    const current = await this.getUser(input.discordId);
    if (!current) {
      throw new Error("User tidak ditemukan");
    }
    if (input.balanceLocks < 0) {
      throw new Error("Saldo tidak boleh negatif");
    }

    const deltaLocks = input.balanceLocks - current.balance_locks;
    const { data, error } = await this.database
      .from("users")
      .update({
        balance_locks: input.balanceLocks,
        updated_at: new Date().toISOString(),
      })
      .eq("discord_id", input.discordId)
      .select("discord_id,grow_id,balance_locks,total_deposit_idr")
      .single();
    throwIfError(error);

    const { error: transactionError } = await this.database.from("transactions").insert({
      user_id: input.discordId,
      type: deltaLocks >= 0 ? "topup" : "purchase",
      amount_idr: deltaLocks >= 0 ? input.deltaIdr : -input.deltaIdr,
      fee_idr: 0,
      gross_amount_idr: deltaLocks >= 0 ? input.deltaIdr : -input.deltaIdr,
      amount_locks: deltaLocks,
      status: "settlement",
      midtrans_order_id: `MANUAL-SET-${input.discordId}-${Date.now()}-${randomUUID()}`,
      raw_payload: {
        source: "manual_set_balance",
        note: input.note ?? "",
        actor_discord_id: input.actorDiscordId,
        previous_balance_locks: current.balance_locks,
        new_balance_locks: input.balanceLocks,
        delta_locks: deltaLocks,
        delta_idr: deltaLocks >= 0 ? input.deltaIdr : -input.deltaIdr,
      },
    });
    throwIfError(transactionError);

    return data as UserAccount;
  }

  async getStoreSettings(): Promise<StoreSettings> {
    const [dlRate, depositWorld] = await Promise.all([
      this.getSetting<number>("dl_rate_idr_per_dl"),
      this.getSetting<StoreSettings["deposit_world"]>("deposit_world"),
    ]);
    return {
      qris_rate_idr_per_dl: dlRate,
      dl_rate_idr_per_dl: dlRate,
      deposit_world: depositWorld,
    };
  }

  async createTopup(input: TopupInput): Promise<Transaction> {
    await this.ensureUser(input.discordId);
    const { data, error } = await this.database
      .from("transactions")
      .insert({
        user_id: input.discordId,
        type: "topup",
        amount_idr: input.amountIdr,
        fee_idr: input.feeIdr,
        gross_amount_idr: input.grossAmountIdr,
        amount_locks: input.amountLocks,
        status: "pending",
        midtrans_order_id: input.orderId,
        expires_at: input.expiresAt.toISOString(),
      })
      .select("*")
      .single();
    throwIfError(error);
    return data as Transaction;
  }

  async updateTopupGateway(
    orderId: string,
    transactionId: string,
    qrUrl: string,
    payload: unknown,
  ): Promise<void> {
    const { error } = await this.database
      .from("transactions")
      .update({
        midtrans_transaction_id: transactionId,
        qr_url: qrUrl,
        raw_payload: payload,
        updated_at: new Date().toISOString(),
      })
      .eq("midtrans_order_id", orderId)
      .eq("type", "topup");
    throwIfError(error);
  }

  async markTopupFailed(orderId: string, payload: unknown): Promise<void> {
    const { error } = await this.database
      .from("transactions")
      .update({
        status: "failed",
        raw_payload: payload,
        updated_at: new Date().toISOString(),
      })
      .eq("midtrans_order_id", orderId)
      .eq("status", "pending");
    throwIfError(error);
  }

  async getTransaction(orderId: string): Promise<Transaction | null> {
    const { data, error } = await this.database
      .from("transactions")
      .select("*")
      .eq("midtrans_order_id", orderId)
      .eq("type", "topup")
      .maybeSingle();
    throwIfError(error);
    return data as Transaction | null;
  }

  async listPendingTopups(limit = 50): Promise<Transaction[]> {
    const { data, error } = await this.database
      .from("transactions")
      .select("*")
      .eq("type", "topup")
      .eq("status", "pending")
      .not("midtrans_order_id", "is", null)
      .order("created_at", { ascending: true })
      .limit(limit);
    throwIfError(error);
    return (data ?? []) as Transaction[];
  }

  async settleTopup(input: {
    orderId: string;
    midtransTransactionId: string;
    transactionStatus: string;
    grossAmountIdr: number;
    payload: unknown;
    force?: boolean;
  }): Promise<SettlementResult> {
    const { data, error } = await this.database.rpc("settle_topup", {
      p_order_id: input.orderId,
      p_midtrans_transaction_id: input.midtransTransactionId,
      p_transaction_status: input.transactionStatus,
      p_gross_amount: input.grossAmountIdr,
      p_raw_payload: input.payload,
      p_force: input.force ?? false,
    });
    throwIfError(error);
    const result = (data as SettlementResult[] | null)?.[0];
    if (!result) throw new Error("Settlement top-up gagal diproses");
    return result;
  }

  async getTransactionById(transactionId: string): Promise<Transaction | null> {
    const { data, error } = await this.database
      .from("transactions")
      .select("*")
      .eq("id", transactionId)
      .maybeSingle();
    throwIfError(error);
    return data as Transaction | null;
  }
}

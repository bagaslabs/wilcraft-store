export interface AppConfig {
  host: string;
  port: number;
  storeName: string;
  discord: {
    token: string;
    clientId: string;
    guildId?: string;
    liveStockChannelId: string;
    adminChannelId?: string;
    buyLogChannelId?: string;
    depositLogChannelId?: string;
    adminRoleIds: string[];
    purchaseRoleIds: string[];
  };
  supabase: {
    url: string;
    serviceRoleKey: string;
  };
  midtrans: {
    serverKey: string;
    enabled: boolean;
    production: boolean;
    feePercent: number;
    expiryMinutes: number;
  };
  topup: {
    minimumIdr: number;
    maximumIdr: number;
  };
}

function required(env: NodeJS.ProcessEnv, key: string): string {
  const value = env[key]?.trim();
  if (!value) {
    throw new Error(`Environment variable ${key} wajib diisi`);
  }
  return value;
}

function positiveInteger(
  value: string | undefined,
  fallback: number,
  key: string,
): number {
  const parsed = value === undefined ? fallback : Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`${key} harus berupa bilangan bulat positif`);
  }
  return parsed;
}

function nonNegativeNumber(
  value: string | undefined,
  fallback: number,
  key: string,
): number {
  const parsed = value === undefined ? fallback : Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new Error(`${key} harus berupa angka non-negatif`);
  }
  return parsed;
}

function stringList(value: string | undefined): string[] {
  return (
    value
      ?.split(",")
      .map((item) => item.trim())
      .filter(Boolean) ?? []
  );
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const minimumIdr = positiveInteger(
    env.MIN_TOPUP_IDR,
    10_000,
    "MIN_TOPUP_IDR",
  );
  const maximumIdr = positiveInteger(
    env.MAX_TOPUP_IDR,
    10_000_000,
    "MAX_TOPUP_IDR",
  );

  if (minimumIdr > maximumIdr) {
    throw new Error("MIN_TOPUP_IDR tidak boleh melebihi MAX_TOPUP_IDR");
  }

  return {
    host: env.HOST?.trim() || "0.0.0.0",
    port: positiveInteger(env.PORT, 3000, "PORT"),
    storeName: env.STORE_NAME?.trim() || "Over Store",
    discord: {
      token: required(env, "DISCORD_TOKEN"),
      clientId: required(env, "DISCORD_CLIENT_ID"),
      guildId: env.DISCORD_GUILD_ID?.trim() || undefined,
      liveStockChannelId: required(env, "LIVE_STOCK_CHANNEL_ID"),
      adminChannelId: env.ADMIN_CHANNEL_ID?.trim() || undefined,
      buyLogChannelId: env.BUY_LOG_CHANNEL_ID?.trim() || undefined,
      depositLogChannelId: env.DEPOSIT_LOG_CHANNEL_ID?.trim() || undefined,
      adminRoleIds: stringList(env.ADMIN_ROLE_IDS),
      purchaseRoleIds: stringList(
        env.PURCHASE_ROLE_IDS ?? env.PURCHASE_ROLE_ID,
      ),
    },
    supabase: {
      url: required(env, "SUPABASE_URL"),
      serviceRoleKey: required(env, "SUPABASE_SERVICE_ROLE_KEY"),
    },
    midtrans: {
      serverKey: env.MIDTRANS_SERVER_KEY?.trim() ?? "",
      enabled: Boolean(env.MIDTRANS_SERVER_KEY?.trim()),
      production: env.MIDTRANS_IS_PRODUCTION?.toLowerCase() === "true",
      feePercent: nonNegativeNumber(
        env.QRIS_FEE_PERCENT,
        0.7,
        "QRIS_FEE_PERCENT",
      ),
      expiryMinutes: positiveInteger(
        env.QRIS_EXPIRY_MINUTES,
        10,
        "QRIS_EXPIRY_MINUTES",
      ),
    },
    topup: {
      minimumIdr,
      maximumIdr,
    },
  };
}

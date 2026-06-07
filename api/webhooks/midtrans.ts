import { createHash, timingSafeEqual } from "node:crypto";

import { createClient } from "@supabase/supabase-js";

interface MidtransNotification {
  order_id: string;
  status_code: string;
  gross_amount: string;
  signature_key: string;
  transaction_id: string;
  transaction_status: string;
  fraud_status?: string;
  [key: string]: unknown;
}

interface SettlementResult {
  transaction_id: string;
  discord_id: string;
  amount_idr: number;
  credited_locks: number;
  balance_locks: number;
  already_credited: boolean;
}

function required(key: string): string {
  const value = process.env[key]?.trim();
  if (!value) throw new Error(`Environment variable ${key} wajib diisi`);
  return value;
}

function json(payload: unknown, status = 200): Response {
  return Response.json(payload, { status });
}

function requireString(
  record: Record<string, unknown>,
  key: string,
): string {
  const value = record[key];
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`Payload Midtrans tidak memiliki ${key}`);
  }
  return value;
}

function parseNotification(value: unknown): MidtransNotification {
  if (typeof value !== "object" || value === null) {
    throw new Error("Payload Midtrans tidak valid");
  }
  const record = value as Record<string, unknown>;
  return {
    ...record,
    order_id: requireString(record, "order_id"),
    status_code: requireString(record, "status_code"),
    gross_amount: requireString(record, "gross_amount"),
    signature_key: requireString(record, "signature_key"),
    transaction_id: requireString(record, "transaction_id"),
    transaction_status: requireString(record, "transaction_status"),
    fraud_status:
      typeof record.fraud_status === "string"
        ? record.fraud_status
        : undefined,
  };
}

function verifyNotification(
  notification: MidtransNotification,
  serverKey: string,
): boolean {
  const expected = createHash("sha512")
    .update(
      `${notification.order_id}${notification.status_code}${notification.gross_amount}${serverKey}`,
      "utf8",
    )
    .digest("hex");
  const left = Buffer.from(expected);
  const right = Buffer.from(notification.signature_key);
  return left.length === right.length && timingSafeEqual(left, right);
}

function isSuccessful(notification: MidtransNotification): boolean {
  const status = notification.transaction_status.toLowerCase();
  const fraud = notification.fraud_status?.toLowerCase();
  return (
    (status === "settlement" || status === "capture") &&
    (fraud === undefined || fraud === "accept")
  );
}

function formatLockUnits(totalLocks: number): string {
  const normalized = Math.max(0, Math.trunc(totalLocks));
  const bgl = Math.floor(normalized / 10_000);
  const afterBgl = normalized % 10_000;
  const dl = Math.floor(afterBgl / 100);
  const wl = afterBgl % 100;
  const parts: string[] = [];
  if (bgl > 0) parts.push(`${bgl} bgl`);
  if (dl > 0) parts.push(`${dl} dl`);
  if (wl > 0) parts.push(`${wl} wl`);
  return parts.length > 0 ? parts.join(" ") : "0 wl";
}

async function notifyDiscord(result: SettlementResult): Promise<void> {
  const token = process.env.DISCORD_TOKEN?.trim();
  if (!token) return;

  const headers = {
    Authorization: `Bot ${token}`,
    "Content-Type": "application/json",
  };
  const dmResponse = await fetch(
    "https://discord.com/api/v10/users/@me/channels",
    {
      method: "POST",
      headers,
      body: JSON.stringify({ recipient_id: result.discord_id }),
    },
  );
  if (!dmResponse.ok) {
    throw new Error(`Discord create DM gagal: HTTP ${dmResponse.status}`);
  }

  const dm = (await dmResponse.json()) as { id?: string };
  if (!dm.id) throw new Error("Discord tidak mengembalikan DM channel ID");

  const messageResponse = await fetch(
    `https://discord.com/api/v10/channels/${dm.id}/messages`,
    {
      method: "POST",
      headers,
      body: JSON.stringify({
        embeds: [
          {
            color: 0x2ecc71,
            title: "Top-Up Berhasil",
            description: [
              `Saldo masuk: **${formatLockUnits(result.credited_locks)}**`,
              `Saldo sekarang: **${formatLockUnits(result.balance_locks)}**`,
              `Transaction ID: \`${result.transaction_id}\``,
            ].join("\n"),
          },
        ],
      }),
    },
  );
  if (!messageResponse.ok) {
    throw new Error(`Discord kirim DM gagal: HTTP ${messageResponse.status}`);
  }
}

export async function POST(request: Request): Promise<Response> {
  try {
    const serverKey = required("MIDTRANS_SERVER_KEY");
    const database = createClient(
      required("SUPABASE_URL"),
      required("SUPABASE_SERVICE_ROLE_KEY"),
      {
        auth: {
          autoRefreshToken: false,
          persistSession: false,
        },
      },
    );

    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return json({ ok: false, error: "Payload JSON tidak valid" }, 400);
    }

    let notification;
    try {
      notification = parseNotification(body);
    } catch (error) {
      return json(
        {
          ok: false,
          error:
            error instanceof Error ? error.message : "Payload tidak valid",
        },
        400,
      );
    }

    if (!verifyNotification(notification, serverKey)) {
      return json({ ok: false, error: "Signature tidak valid" }, 401);
    }

    if (!isSuccessful(notification)) {
      return json({
        ok: true,
        processed: false,
        status: notification.transaction_status,
      });
    }

    const grossAmountIdr = Number(notification.gross_amount);
    if (
      !Number.isFinite(grossAmountIdr) ||
      grossAmountIdr < 0 ||
      !Number.isInteger(grossAmountIdr)
    ) {
      return json({ ok: false, error: "gross_amount tidak valid" }, 400);
    }

    const { data, error } = await database.rpc("settle_topup", {
      p_order_id: notification.order_id,
      p_midtrans_transaction_id: notification.transaction_id,
      p_transaction_status: notification.transaction_status,
      p_gross_amount: grossAmountIdr,
      p_raw_payload: notification,
      p_force: false,
    });
    if (error) throw new Error(error.message);
    const result = (data as SettlementResult[] | null)?.[0];
    if (!result) throw new Error("Settlement top-up gagal diproses");

    if (!result.already_credited) {
      await notifyDiscord(result).catch((error) => {
        console.error("Gagal mengirim DM pembayaran:", error);
      });
    }

    return json({
      ok: true,
      processed: !result.already_credited,
    });
  } catch (error) {
    console.error("Gagal memproses webhook Midtrans:", error);
    return json({ ok: false, error: "Webhook gagal diproses" }, 500);
  }
}

export function GET(): Response {
  return json({
    ok: true,
    endpoint: "Midtrans payment notification",
    method: "POST",
  });
}

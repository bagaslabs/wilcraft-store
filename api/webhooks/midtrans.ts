import { createClient } from "@supabase/supabase-js";

import { formatLockUnits } from "../../src/lib/money";
import { StoreRepository } from "../../src/repositories/store";
import {
  MidtransService,
  parseMidtransNotification,
} from "../../src/services/midtrans";
import type { SettlementResult } from "../../src/types";

function required(key: string): string {
  const value = process.env[key]?.trim();
  if (!value) throw new Error(`Environment variable ${key} wajib diisi`);
  return value;
}

function json(payload: unknown, status = 200): Response {
  return Response.json(payload, { status });
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
    const store = new StoreRepository(database);
    const midtrans = new MidtransService({
      serverKey,
      enabled: true,
      production:
        process.env.MIDTRANS_IS_PRODUCTION?.toLowerCase() === "true",
      feePercent: 0,
      expiryMinutes: 10,
    });

    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return json({ ok: false, error: "Payload JSON tidak valid" }, 400);
    }

    let notification;
    try {
      notification = parseMidtransNotification(body);
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

    if (!midtrans.verifyNotification(notification)) {
      return json({ ok: false, error: "Signature tidak valid" }, 401);
    }

    if (!midtrans.isSuccessful(notification)) {
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

    const result = await store.settleTopup({
      orderId: notification.order_id,
      midtransTransactionId: notification.transaction_id,
      transactionStatus: notification.transaction_status,
      grossAmountIdr,
      payload: notification,
    });

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

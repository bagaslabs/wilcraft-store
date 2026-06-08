# Over Store Bot

Bot Discord self-service untuk penjualan item Growtopia sesuai
`PRD_Discord_Bot_Growtopia_Shop.md`.

## Fitur

- Live stock diperbarui otomatis setiap 30 detik
- Pembelian privat dengan pengurangan saldo dan stok secara atomik
- Registrasi GrowID, cek saldo, dan informasi deposit world
- Top-up QRIS Midtrans dengan verifikasi signature webhook
- Settlement idempoten agar webhook duplikat tidak menggandakan saldo
- Manajemen produk, stok, rate, dan pembayaran melalui `/shop`

Item stok dikirim sebagai file privat pada balasan ephemeral. Implementasi ini
tidak mengontrol bot Growtopia di dalam game karena integrasi langsung dengan
Growtopia dinyatakan di luar cakupan v1.

## Persiapan

1. Install dependency:

   ```bash
   bun install
   ```

2. Buat project Supabase, buka SQL Editor, lalu jalankan
   `supabase/migrations/001_initial_schema.sql`.

3. Buat aplikasi dan bot di Discord Developer Portal. Aktifkan scope `bot` dan
   `applications.commands`, lalu beri izin View Channels, Send Messages,
   Embed Links, Attach Files, Read Message History, Use Application Commands,
   dan Manage Roles jika ingin role otomatis setelah pembelian.

4. Salin `.env.example` menjadi `.env`, lalu isi semua kredensial dan ID channel.
   `SUPABASE_SERVICE_ROLE_KEY` dan `MIDTRANS_SERVER_KEY` hanya boleh berada di
   server. `MIDTRANS_SERVER_KEY` boleh dikosongkan selama integrasi QRIS belum
   digunakan.
   Tambahkan juga `BUY_LOG_CHANNEL_ID` dan `DEPOSIT_LOG_CHANNEL_ID` jika kamu
   ingin log pembelian dan deposit dikirim ke channel khusus.
   Isi `PURCHASE_ROLE_IDS` dengan role ID yang dipisahkan koma jika pembeli
   perlu diberi role otomatis. Pastikan role bot berada di atas role tersebut.

5. Jalankan:

   ```bash
   bun run dev
   ```

Untuk produksi gunakan `bun run start` melalui process manager dan endpoint
HTTPS publik.

## Midtrans

Bot menggunakan Core API QRIS:

- Sandbox: `https://api.sandbox.midtrans.com/v2/charge`
- Production: `https://api.midtrans.com/v2/charge`
- Webhook: `POST https://domain-anda/webhooks/midtrans`

Atur Payment Notification URL tersebut pada dashboard Midtrans. Mulai dengan
`MIDTRANS_IS_PRODUCTION=false`. Webhook memverifikasi signature SHA-512,
status pembayaran, fraud status, nominal lokal, dan idempotensi kredit.

QRIS dikonfigurasi kedaluwarsa dalam 10 menit sesuai PRD. Nilai ini dapat
diubah melalui `QRIS_EXPIRY_MINUTES`.

## Command Admin

Semua command berada di bawah `/shop`:

- `panel`, `refresh`
- `product-add`, `product-edit`, `product-delete`
- `stock-add`, `stock-view`
- `set-rate`, `add-balance`, `remove-balance`, `set-balance`, `set-deposit-world`
- `confirm-payment`

`/shop add-balance`, `remove-balance`, dan `set-balance` menerima `bgl`, `dl`,
dan `wl`.

`stock-add` menerima file teks maksimal 1 MB dengan satu item per baris.
`product-delete` melakukan soft delete agar riwayat order tetap utuh.

Secara default command membutuhkan permission Administrator. `ADMIN_ROLE_IDS`
dapat berisi daftar role ID yang dipisahkan koma. `ADMIN_CHANNEL_ID` membatasi
command ke satu channel.

## Verifikasi

```bash
bun run check
```

Health check tersedia pada `GET /health`.

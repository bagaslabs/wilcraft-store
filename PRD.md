# PRD — Discord Bot Penjualan Item Growtopia
**Project:** Over Store Bot  
**Stack:** Elysia.js · Supabase · Midtrans  
**Status:** Draft  
**Last Updated:** June 2026

---

## 1. Overview

Bot Discord otomatis untuk penjualan item/jasa Growtopia secara self-service. Pembeli dapat melihat stok, membeli produk, top-up saldo, dan cek balance langsung dari Discord tanpa perlu menghubungi admin secara manual. Admin mengelola produk, stok, dan transaksi juga melalui Discord.

---

## 2. Tujuan

- Mengotomasi proses jual beli item Growtopia via Discord
- Meminimalkan intervensi manual admin dalam transaksi harian
- Menyediakan sistem pembayaran QRIS terintegrasi via Midtrans
- Memberikan pengalaman belanja yang cepat dan transparan bagi pembeli

---

## 3. Pengguna

| Role | Deskripsi |
|---|---|
| **Buyer** | Member Discord yang ingin membeli produk |
| **Admin** | Pemilik/pengelola toko, mengatur produk & stok via Discord |

---

## 4. Fitur Utama

### 4.1 Live Stock Display
- Bot secara otomatis memposting dan mengupdate daftar produk di channel `#live-stock`
- Setiap produk menampilkan: nama, kode produk, stok tersedia, harga (DL/Lock/Rupiah), dan total terjual
- Label "Last Update: X seconds ago" ditampilkan di atas daftar
- Stok habis otomatis disembunyikan atau ditandai

### 4.2 Pembelian Produk (Buy)
- Tombol **Buy** memunculkan modal form dengan field:
  - `Code of Product` — kode produk yang ingin dibeli
  - `Amount` — jumlah yang ingin dibeli
- Setelah submit, bot memvalidasi stok dan saldo, lalu langsung mengirimkan item ke buyer
- Konfirmasi pembelian dikirim sebagai pesan privat (ephemeral) berisi detail order

### 4.3 Manajemen GrowID (Set GrowID)
- Tombol **Set GrowID** memunculkan modal registrasi akun dengan field:
  - `Input Account Name`
  - `Confirm Account Name`
- GrowID disimpan ke akun Discord buyer dan digunakan untuk pengiriman item

### 4.4 Cek Saldo (Balance)
- Tombol **Balance** menampilkan informasi saldo buyer secara privat:
  - GrowID terdaftar
  - Saldo aktif (DL/Lock)
  - Total deposit keseluruhan

### 4.5 Info Deposit World (Deposit World)
- Tombol **Deposit World** menampilkan informasi world untuk deposit manual in-game:
  - Nama world
  - Nama owner
  - Nama bot in-game
  - Catatan: jangan donasi jika bot bukan yang ada di world

### 4.6 Top-Up Saldo via QRIS (Midtrans)
- Tombol **QRIS TopUp** memunculkan modal input nominal (dalam Rupiah)
- Bot melakukan request ke **Midtrans API** untuk membuat transaksi QRIS dinamis
- Bot menampilkan detail transaksi ke buyer:
  - Transaction Code unik (dari Midtrans)
  - Nominal + biaya QRIS (fee Midtrans)
  - Konversi ke DL/Lock berdasarkan rate aktif
  - QR Code kedaluwarsa dalam 10 menit
- Midtrans mengirim **webhook** ke server Elysia saat pembayaran berhasil
- Server memverifikasi signature webhook Midtrans, lalu update saldo buyer di Supabase
- Bot mengirim notifikasi sukses ke buyer secara otomatis

### 4.7 Kurs / Rate Info
- Bot menampilkan kurs aktif: `Rate QRIS` dan `Rate DL` dalam Rupiah/DL
- Diupdate oleh admin via command

---

## 5. Manajemen Produk (Admin via Discord)

Semua pengelolaan dilakukan melalui slash command di channel admin.

| Fitur | Deskripsi |
|---|---|
| Tambah Produk | Menambah produk baru dengan nama, kode, harga, deskripsi |
| Edit Produk | Mengubah harga, deskripsi, atau kode produk |
| Hapus Produk | Menghapus produk dari daftar |
| Tambah Stok | Upload stok baru (format teks, satu item per baris) |
| Lihat Stok | Cek jumlah stok tersedia per produk |
| Set Rate | Mengubah kurs QRIS/DL |
| Konfirmasi Pembayaran | Override manual jika webhook Midtrans gagal masuk |

---

## 6. Alur Transaksi

```
Buyer klik [Buy]
  → Isi kode produk & jumlah
  → Bot cek stok & saldo
  → Jika cukup: kirim item, kurangi stok & saldo, kirim konfirmasi
  → Jika tidak cukup: tampilkan pesan error
```

```
Buyer klik [QRIS TopUp]
  → Isi nominal Rupiah
  → Bot request ke Midtrans API → dapat QR Code + kode transaksi
  → Bot tampilkan QR di Discord (expired 10 menit)
  → Buyer scan & bayar via aplikasi bank/e-wallet
  → Midtrans kirim webhook ke server Elysia
  → Server verifikasi signature → update saldo di Supabase
  → Bot notif buyer: saldo berhasil ditambahkan
```

---

## 7. Integrasi Midtrans

**Midtrans** (midtrans.com) digunakan sebagai payment gateway untuk memproses pembayaran QRIS.

### Kebutuhan
- Akun merchant Midtrans — tersedia dua environment: **Sandbox** (testing) dan **Production** (live)
- Untuk Production wajib melengkapi dokumen bisnis/usaha
- `Server Key` & `Client Key` dari dashboard Midtrans
- Server dengan IP publik / domain untuk menerima notifikasi pembayaran

### Yang Digunakan dari Midtrans
| Fitur Midtrans | Fungsi di Bot |
|---|---|
| Charge API (QRIS) | Generate QRIS dinamis saat buyer top-up |
| QR Code URL | Ditampilkan di Discord sebagai gambar |
| HTTP Notification (Webhook) | Notifikasi otomatis saat pembayaran sukses |
| Signature Key Validation | Verifikasi bahwa notifikasi benar dari Midtrans |

### Catatan Penting
- Server Elysia **wajib** punya endpoint publik (misal `https://domain.com/webhook/midtrans`) agar Midtrans bisa mengirim notifikasi pembayaran
- Localhost/lokal tidak bisa menerima webhook — harus deploy ke VPS atau platform cloud
- Fee QRIS Midtrans (biasanya 0.7%) dibebankan ke buyer dan ditampilkan transparan saat top-up
- Gunakan environment **Sandbox** dulu saat development sebelum go-live

---

## 8. Database (Supabase)

Tabel utama yang diperlukan:

| Tabel | Isi |
|---|---|
| `users` | Discord ID, GrowID, saldo DL, saldo Lock, total deposit |
| `products` | ID, nama, kode, harga DL, harga Lock, harga Rupiah, deskripsi, total terjual |
| `stock_items` | ID, product_id, isi item (string), status (available/sold) |
| `orders` | ID, buyer Discord ID, product_id, jumlah, total harga, timestamp |
| `transactions` | ID, user_id, tipe (topup/purchase), nominal, status, kode transaksi Midtrans |
| `settings` | Key-value untuk rate, deposit world info, dll |

---

## 9. Tech Stack

| Layer | Teknologi |
|---|---|
| Runtime | Bun + Elysia.js |
| Bot Framework | Discord.js v14 |
| Database | Supabase (PostgreSQL) |
| Payment Gateway | Midtrans (QRIS Dinamis (Snap API)) |
| Deployment | VPS / Railway (wajib IP publik untuk webhook) |

---

## 10. Non-Functional Requirements

- Respons bot < 2 detik untuk aksi umum (buy, balance, dll)
- Live stock diupdate otomatis setiap ≤ 30 detik
- QRIS QR Code expired otomatis setelah 10 menit (dikontrol Midtrans)
- Semua response pembelian/saldo bersifat ephemeral (hanya terlihat oleh buyer)
- Webhook Midtrans harus diverifikasi signature-nya sebelum diproses
- Bot harus tetap online 24/7

---

## 11. Out of Scope (v1)

- Web dashboard admin
- Multi-server support
- Sistem affiliate/referral
- Integrasi langsung dengan API Growtopia
- Support metode pembayaran lain selain QRIS

---

## 12. Milestone

| Fase | Deliverable |
|---|---|
| **Fase 1** | Setup bot, live stock display, manajemen produk via Discord |
| **Fase 2** | Set GrowID, Buy flow, pengiriman item otomatis |
| **Fase 3** | Balance, QRIS TopUp, integrasi Midtrans + webhook handler |
| **Fase 4** | Deposit World, Rate info, stabilisasi & monitoring |

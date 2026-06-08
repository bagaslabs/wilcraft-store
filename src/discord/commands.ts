import {
  PermissionFlagsBits,
  SlashCommandBuilder,
} from "discord.js";

export const shopCommand = new SlashCommandBuilder()
  .setName("shop")
  .setDescription("Kelola Over Store")
  .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
  .addSubcommand((command) =>
    command
      .setName("panel")
      .setDescription("Buat atau perbarui panel live stock"),
  )
  .addSubcommand((command) =>
    command
      .setName("refresh")
      .setDescription("Paksa pembaruan live stock sekarang"),
  )
  .addSubcommand((command) =>
    command
      .setName("product-add")
      .setDescription("Tambah produk baru")
      .addStringOption((option) =>
        option.setName("name").setDescription("Nama produk").setRequired(true),
      )
      .addStringOption((option) =>
        option
          .setName("code")
          .setDescription("Kode unik produk")
          .setRequired(true),
      )
      .addIntegerOption((option) =>
        option
          .setName("price_locks")
          .setDescription("Harga dalam Lock (100 Lock = 1 DL)")
          .setMinValue(0)
          .setRequired(true),
      )
      .addIntegerOption((option) =>
        option
          .setName("price_idr")
          .setDescription("Harga referensi dalam Rupiah")
          .setMinValue(0),
      )
      .addStringOption((option) =>
        option.setName("description").setDescription("Deskripsi produk"),
      ),
  )
  .addSubcommand((command) =>
    command
      .setName("product-edit")
      .setDescription("Ubah produk")
      .addStringOption((option) =>
        option
          .setName("code")
          .setDescription("Kode produk saat ini")
          .setRequired(true),
      )
      .addStringOption((option) =>
        option.setName("name").setDescription("Nama baru"),
      )
      .addStringOption((option) =>
        option.setName("new_code").setDescription("Kode baru"),
      )
      .addIntegerOption((option) =>
        option
          .setName("price_locks")
          .setDescription("Harga baru dalam Lock")
          .setMinValue(0),
      )
      .addIntegerOption((option) =>
        option
          .setName("price_idr")
          .setDescription("Harga referensi baru dalam Rupiah")
          .setMinValue(0),
      )
      .addStringOption((option) =>
        option.setName("description").setDescription("Deskripsi baru"),
      )
      .addBooleanOption((option) =>
        option.setName("active").setDescription("Tampilkan produk"),
      ),
  )
  .addSubcommand((command) =>
    command
      .setName("product-delete")
      .setDescription("Nonaktifkan produk")
      .addStringOption((option) =>
        option
          .setName("code")
          .setDescription("Kode produk")
          .setRequired(true),
      ),
  )
  .addSubcommand((command) =>
    command
      .setName("stock-add")
      .setDescription("Tambah stok dari file teks, satu item per baris")
      .addStringOption((option) =>
        option
          .setName("code")
          .setDescription("Kode produk")
          .setRequired(true),
      )
      .addAttachmentOption((option) =>
        option
          .setName("file")
          .setDescription("File .txt berisi stok")
          .setRequired(true),
      ),
  )
  .addSubcommand((command) =>
    command
      .setName("stock-view")
      .setDescription("Lihat jumlah stok produk")
      .addStringOption((option) =>
        option
          .setName("code")
          .setDescription("Kode produk")
          .setRequired(true),
      ),
  )
  .addSubcommand((command) =>
    command
      .setName("set-rate")
      .setDescription("Atur kurs Rupiah per DL")
      .addIntegerOption((option) =>
        option
          .setName("dl_rate")
          .setDescription("Rate DL dalam Rupiah per DL")
          .setMinValue(1)
          .setRequired(true),
      ),
  )
  .addSubcommand((command) =>
    command
      .setName("add-balance")
      .setDescription("Tambah saldo manual ke user")
      .addUserOption((option) =>
        option.setName("user").setDescription("Target user").setRequired(true),
      )
      .addIntegerOption((option) =>
        option
          .setName("bgl")
          .setDescription("Jumlah Blue Gem Lock")
          .setMinValue(0)
          .setRequired(true),
      )
      .addIntegerOption((option) =>
        option
          .setName("dl")
          .setDescription("Jumlah Diamond Lock")
          .setMinValue(0)
          .setRequired(true),
      )
      .addIntegerOption((option) =>
        option
          .setName("wl")
          .setDescription("Jumlah World Lock")
          .setMinValue(0)
          .setRequired(true),
      )
      .addStringOption((option) =>
        option.setName("note").setDescription("Catatan tambahan"),
      ),
  )
  .addSubcommand((command) =>
    command
      .setName("remove-balance")
      .setDescription("Kurangi saldo user")
      .addUserOption((option) =>
        option.setName("user").setDescription("Target user").setRequired(true),
      )
      .addIntegerOption((option) =>
        option
          .setName("bgl")
          .setDescription("Jumlah Blue Gem Lock")
          .setMinValue(0)
          .setRequired(true),
      )
      .addIntegerOption((option) =>
        option
          .setName("dl")
          .setDescription("Jumlah Diamond Lock")
          .setMinValue(0)
          .setRequired(true),
      )
      .addIntegerOption((option) =>
        option
          .setName("wl")
          .setDescription("Jumlah World Lock")
          .setMinValue(0)
          .setRequired(true),
      )
      .addStringOption((option) =>
        option.setName("note").setDescription("Catatan tambahan"),
      ),
  )
  .addSubcommand((command) =>
    command
      .setName("set-balance")
      .setDescription("Set saldo user ke nominal tertentu")
      .addUserOption((option) =>
        option.setName("user").setDescription("Target user").setRequired(true),
      )
      .addIntegerOption((option) =>
        option
          .setName("bgl")
          .setDescription("Saldo Blue Gem Lock")
          .setMinValue(0)
          .setRequired(true),
      )
      .addIntegerOption((option) =>
        option
          .setName("dl")
          .setDescription("Saldo Diamond Lock")
          .setMinValue(0)
          .setRequired(true),
      )
      .addIntegerOption((option) =>
        option
          .setName("wl")
          .setDescription("Saldo World Lock")
          .setMinValue(0)
          .setRequired(true),
      )
      .addStringOption((option) =>
        option.setName("note").setDescription("Catatan tambahan"),
      ),
  )
  .addSubcommand((command) =>
    command
      .setName("set-deposit-world")
      .setDescription("Atur informasi world deposit")
      .addStringOption((option) =>
        option.setName("world").setDescription("Nama world").setRequired(true),
      )
      .addStringOption((option) =>
        option.setName("owner").setDescription("Nama owner").setRequired(true),
      )
      .addStringOption((option) =>
        option
          .setName("bot_name")
          .setDescription("Nama bot in-game")
          .setRequired(true),
      )
      .addStringOption((option) =>
        option.setName("note").setDescription("Catatan keamanan"),
      ),
  )
  .addSubcommand((command) =>
    command
      .setName("confirm-payment")
      .setDescription("Konfirmasi pembayaran yang webhook-nya gagal")
      .addStringOption((option) =>
        option
          .setName("order_id")
          .setDescription("Order ID Midtrans")
          .setRequired(true),
      )
      .addBooleanOption((option) =>
        option
          .setName("force")
          .setDescription("Kredit tanpa status settlement Midtrans"),
      ),
  );

export const commands = [shopCommand.toJSON()];

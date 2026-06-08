import { randomBytes } from "node:crypto";

import {
  ActionRowBuilder,
  AttachmentBuilder,
  ChannelType,
  Client,
  EmbedBuilder,
  Events,
  GatewayIntentBits,
  MessageFlags,
  ModalBuilder,
  PermissionFlagsBits,
  REST,
  Routes,
  TextInputBuilder,
  TextInputStyle,
  type ButtonInteraction,
  type ChatInputCommandInteraction,
  type Interaction,
  type ModalSubmitInteraction,
  type TextChannel,
} from "discord.js";

import type { AppConfig } from "../config";
import {
  calculateFee,
  formatIdr,
  formatLockUnits,
  locksFromIdr,
  parsePositiveInteger,
} from "../lib/money";
import type { StoreRepository } from "../repositories/store";
import type {
  MidtransNotification,
  MidtransService,
} from "../services/midtrans";
import { parseMidtransGrossAmount } from "../services/midtrans";
import type { ProductUpdate, SettlementResult } from "../types";
import { commands } from "./commands";
import { buildStorePanel, BUTTON_IDS, MODAL_IDS } from "./views";

const GROW_ID_PATTERN = /^[A-Za-z0-9]{3,18}$/;
const EPHEMERAL_DELETE_DELAY_MS = 14 * 60 * 1_000;

function modalRow(input: TextInputBuilder) {
  return new ActionRowBuilder<TextInputBuilder>().addComponents(input);
}

function errorMessage(error: unknown): string {
  if (!(error instanceof Error)) return "Terjadi kesalahan yang tidak diketahui.";
  const knownMessages = [
    "GrowID belum diatur",
    "Kode produk tidak ditemukan",
    "Saldo tidak mencukupi",
    "Saldo user tidak mencukupi",
    "Kurangi minimal",
    "Saldo tidak boleh negatif",
    "Stok produk tidak mencukupi",
    "Jumlah pembelian harus",
    "duplicate key",
  ];
  return knownMessages.some((message) => error.message.includes(message))
    ? error.message.replace("duplicate key", "Kode atau stok tersebut sudah ada")
    : "Operasi gagal diproses. Silakan coba lagi atau hubungi admin.";
}

function isUnknownInteraction(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === 10062
  );
}

function formatEmojiLocks(totalLocks: number): string {
  const normalized = Math.max(0, Math.trunc(totalLocks));
  const bgl = Math.floor(normalized / 10_000);
  const afterBgl = normalized % 10_000;
  const dl = Math.floor(afterBgl / 100);
  const wl = afterBgl % 100;
  const parts: string[] = [];

  if (bgl > 0) parts.push(`${bgl} 🧊`);
  if (dl > 0) parts.push(`${dl} 🔐`);
  if (wl > 0) parts.push(`${wl} 🔒`);

  return parts.length > 0 ? parts.join(" ") : "0 🔒";
}

function getLockAmount(interaction: ChatInputCommandInteraction): number {
  const bgl = interaction.options.getInteger("bgl", true);
  const dl = interaction.options.getInteger("dl", true);
  const wl = interaction.options.getInteger("wl", true);
  return bgl * 10_000 + dl * 100 + wl;
}

export class StoreBot {
  readonly client = new Client({ intents: [GatewayIntentBits.Guilds] });
  private refreshTimer?: ReturnType<typeof setInterval>;
  private paymentReconcileTimer?: ReturnType<typeof setInterval>;
  private refreshInProgress = false;
  private paymentReconcileInProgress = false;

  constructor(
    private readonly config: AppConfig,
    private readonly store: StoreRepository,
    private readonly midtrans: MidtransService,
  ) {
    this.client.on(Events.InteractionCreate, (interaction) => {
      void this.handleInteraction(interaction);
    });
    this.client.once(Events.ClientReady, (client) => {
      console.log(`Discord bot aktif sebagai ${client.user.tag}`);
      void this.updateLiveStock();
      this.refreshTimer = setInterval(
        () => void this.updateLiveStock(),
        30_000,
      );
      if (this.config.midtrans.enabled) {
        void this.reconcilePendingTopups();
        this.paymentReconcileTimer = setInterval(
          () => void this.reconcilePendingTopups(),
          60_000,
        );
      }
    });
    this.client.on(Events.Error, (error) => {
      console.error("Discord client error:", error);
    });
  }

  async start(): Promise<void> {
    await this.registerCommands();
    await this.client.login(this.config.discord.token);
  }

  async stop(): Promise<void> {
    if (this.refreshTimer) clearInterval(this.refreshTimer);
    if (this.paymentReconcileTimer) {
      clearInterval(this.paymentReconcileTimer);
    }
    this.client.destroy();
  }

  private async reconcilePendingTopups(): Promise<void> {
    if (
      !this.config.midtrans.enabled ||
      this.paymentReconcileInProgress
    ) {
      return;
    }

    this.paymentReconcileInProgress = true;
    try {
      const transactions = await this.store.listPendingTopups();
      for (const transaction of transactions) {
        const orderId = transaction.midtrans_order_id;
        if (!orderId) continue;

        try {
          const status = await this.midtrans.getStatus(orderId);
          if (!this.midtrans.isSuccessful(status)) continue;

          const result = await this.store.settleTopup({
            orderId,
            midtransTransactionId: status.transaction_id,
            transactionStatus: status.transaction_status,
            grossAmountIdr: parseMidtransGrossAmount(status.gross_amount),
            payload: status,
          });
          if (!result.already_credited) {
            await this.notifyPayment(result).catch((error) => {
              console.error(
                `Gagal mengirim notifikasi pembayaran ${orderId}:`,
                error,
              );
            });
            console.info(
              `[Midtrans] Pembayaran ${orderId} direkonsiliasi otomatis.`,
            );
          }
        } catch (error) {
          console.error(
            `Gagal merekonsiliasi pembayaran ${orderId}:`,
            error,
          );
        }
      }
    } catch (error) {
      console.error("Gagal membaca transaksi pending:", error);
    } finally {
      this.paymentReconcileInProgress = false;
    }
  }

  async notifyPayment(result: SettlementResult): Promise<void> {
    const user = await this.client.users.fetch(result.discord_id);
    try {
      await user.send({
        embeds: [
          new EmbedBuilder()
            .setColor(0x2ecc71)
            .setTitle("Top-Up Berhasil")
            .setDescription(
              [
                `Jumlah top-up IDR: **${formatIdr(result.amount_idr)}**`,
                `Saldo masuk: **${formatLockUnits(result.credited_locks)}**`,
                `Saldo sekarang: **${formatLockUnits(result.balance_locks)}**`,
                `Transaction ID: \`${result.transaction_id}\``,
              ].join("\n"),
            ),
        ],
      });
    } catch (error) {
      console.error("Gagal mengirim DM top-up:", error);
    }
    void this.logDeposit({
      discordId: result.discord_id,
      source: "QRIS",
      amountIdr: result.amount_idr,
      creditedLocks: result.credited_locks,
    }).catch((error) => console.error("Gagal menulis deposit log:", error));
  }

  private async sendLogEmbed(
    channelId: string | undefined,
    embed: EmbedBuilder,
  ): Promise<void> {
    if (!channelId) return;

    const channel = await this.client.channels.fetch(channelId).catch(() => null);
    if (!channel || !("send" in channel)) return;

    await channel.send({ embeds: [embed] });
  }

  private async logPurchase(input: {
    discordId: string;
    orderId: string;
    productName: string;
    productCode: string;
    quantity: number;
    totalPriceLocks: number;
  }): Promise<void> {
    const [discordUser, product] = await Promise.all([
      this.client.users.fetch(input.discordId).catch(() => null),
      this.store.getProductByCode(input.productCode).catch(() => null),
    ]);
    const totalPriceIdr =
      product?.price_idr !== null && product?.price_idr !== undefined
        ? product.price_idr * input.quantity
        : null;

    const embed = new EmbedBuilder()
      .setColor(0xf58220)
      .setTitle(`#Order Number: ${input.orderId}`)
      .setDescription(
        [
          `Buyer: ${discordUser ?? `<@${input.discordId}>`}`,
          `Product: **${input.quantity} ${input.productName.toUpperCase()}**`,
          `Code: **${input.productCode}**`,
          `Total Price: **${formatEmojiLocks(input.totalPriceLocks)}${
            totalPriceIdr !== null ? ` | ${formatIdr(totalPriceIdr)}` : ""
          }**`,
          "",
          "**Thanks For Purchasing Our Product ✅**",
        ].join("\n"),
      )
      .setTimestamp();

    await this.sendLogEmbed(this.config.discord.buyLogChannelId, embed);
  }

  private async logDeposit(input: {
    discordId: string;
    source: "QRIS" | "MANUAL";
    amountIdr: number;
    creditedLocks: number;
    note?: string;
  }): Promise<void> {
    const [discordUser, account] = await Promise.all([
      this.client.users.fetch(input.discordId).catch(() => null),
      this.store.getUser(input.discordId).catch(() => null),
    ]);

    const growId = account?.grow_id ?? "Belum diatur";
    const currentBalance = account?.balance_locks ?? input.creditedLocks;
    const embed = new EmbedBuilder()
      .setColor(0xff5fb7)
      .setTitle("👑 Donation Logs 👑")
      .addFields(
        {
          name: "GrowID",
          value: `**${growId}**`,
          inline: true,
        },
        {
          name: "Total WL",
          value: `**${input.creditedLocks.toLocaleString("id-ID")} WL**`,
          inline: true,
        },
        {
          name: "Converted",
          value: `**${formatIdr(input.amountIdr)}**`,
          inline: true,
        },
        {
          name: "Status",
          value: [
            `Successfully Adding item to **${growId}**`,
            `Buyer: ${discordUser ?? `<@${input.discordId}>`}`,
            `Source: **${input.source}**`,
            `Added: **${formatIdr(input.amountIdr)}**`,
            `Current Balance: **${formatLockUnits(currentBalance)}**`,
            input.note ? `Note: ${input.note}` : null,
          ]
            .filter(Boolean)
            .join("\n"),
          inline: false,
        },
      )
      .setTimestamp();

    await this.sendLogEmbed(this.config.discord.depositLogChannelId, embed);
  }

  private async grantPurchaseRoles(input: {
    discordId: string;
    guildId: string | null;
  }): Promise<void> {
    const roleIds = this.config.discord.purchaseRoleIds;
    if (roleIds.length === 0) return;

    const guildId = input.guildId ?? this.config.discord.guildId;
    if (!guildId) {
      console.warn(
        "PURCHASE_ROLE_IDS diatur, tetapi DISCORD_GUILD_ID tidak tersedia.",
      );
      return;
    }

    const guild = await this.client.guilds.fetch(guildId);
    const member = await guild.members.fetch(input.discordId);
    const missingRoleIds = roleIds.filter(
      (roleId) => !member.roles.cache.has(roleId),
    );
    if (missingRoleIds.length === 0) return;

    await member.roles.add(
      missingRoleIds,
      "Role otomatis setelah pembelian berhasil",
    );
  }

  async updateLiveStock(): Promise<void> {
    if (!this.client.isReady() || this.refreshInProgress) return;
    this.refreshInProgress = true;
    try {
      const [products, settings] = await Promise.all([
        this.store.listLiveProducts(),
        this.store.getStoreSettings(),
      ]);
      const payload = buildStorePanel({
        storeName: this.config.storeName,
        products,
        settings,
      });
      const channel = await this.client.channels.fetch(
        this.config.discord.liveStockChannelId,
      );
      if (
        !channel ||
        (channel.type !== ChannelType.GuildText &&
          channel.type !== ChannelType.GuildAnnouncement)
      ) {
        throw new Error("LIVE_STOCK_CHANNEL_ID bukan text channel");
      }

      const textChannel = channel as TextChannel;
      const messageId = await this.store
        .getSetting<string>("live_stock_message_id")
        .catch(() => null);

      if (messageId) {
        const existing = await textChannel.messages.fetch(messageId).catch(() => null);
        if (existing) {
          await existing.edit(payload);
          return;
        }
      }

      const message = await textChannel.send(payload);
      await this.store.setSetting("live_stock_message_id", message.id);
    } catch (error) {
      console.error("Gagal memperbarui live stock:", error);
    } finally {
      this.refreshInProgress = false;
    }
  }

  private async registerCommands(): Promise<void> {
    const rest = new REST({ version: "10" }).setToken(
      this.config.discord.token,
    );
    const route = this.config.discord.guildId
      ? Routes.applicationGuildCommands(
          this.config.discord.clientId,
          this.config.discord.guildId,
        )
      : Routes.applicationCommands(this.config.discord.clientId);
    await rest.put(route, { body: commands });
  }

  private async handleInteraction(interaction: Interaction): Promise<void> {
    try {
      if (interaction.isButton()) {
        await this.handleButton(interaction);
      } else if (interaction.isModalSubmit()) {
        await this.handleModal(interaction);
      } else if (
        interaction.isChatInputCommand() &&
        interaction.commandName === "shop"
      ) {
        await this.handleAdminCommand(interaction);
      }
    } catch (error) {
      if (isUnknownInteraction(error)) {
        const ageMs = Date.now() - interaction.createdTimestamp;
        console.warn(
          `[Discord] Interaction ${interaction.id} gagal di-ACK (10062, umur ${ageMs} ms). Coba ulangi interaksi dan pastikan hanya satu proses bot aktif.`,
        );
        return;
      }

      console.error("Interaction error:", error);
      if (!interaction.isRepliable()) return;
      if (interaction.deferred || interaction.replied) {
        await interaction
          .editReply({ content: errorMessage(error) })
          .catch(() => null);
      } else {
        await interaction
          .reply({
            content: errorMessage(error),
            flags: MessageFlags.Ephemeral,
          })
          .catch(() => null);
      }
    } finally {
      this.scheduleEphemeralDeletion(interaction);
    }
  }

  private scheduleEphemeralDeletion(interaction: Interaction): void {
    if (
      !interaction.isRepliable() ||
      (!interaction.deferred && !interaction.replied) ||
      !("ephemeral" in interaction) ||
      interaction.ephemeral !== true
    ) {
      return;
    }

    const timer = setTimeout(() => {
      void interaction.deleteReply().catch((error: unknown) => {
        if (
          typeof error === "object" &&
          error !== null &&
          "code" in error &&
          (error.code === 10008 || error.code === 10015)
        ) {
          return;
        }
        console.error("Gagal menghapus pesan ephemeral:", error);
      });
    }, EPHEMERAL_DELETE_DELAY_MS);
    timer.unref?.();
  }

  private async handleButton(interaction: ButtonInteraction): Promise<void> {
    switch (interaction.customId) {
      case BUTTON_IDS.buy:
        await interaction.showModal(
          new ModalBuilder()
            .setCustomId(MODAL_IDS.buy)
            .setTitle("Beli Produk")
            .addComponents(
              modalRow(
                new TextInputBuilder()
                  .setCustomId("product_code")
                  .setLabel("Code of Product")
                  .setStyle(TextInputStyle.Short)
                  .setMaxLength(32)
                  .setRequired(true),
              ),
              modalRow(
                new TextInputBuilder()
                  .setCustomId("amount")
                  .setLabel("Amount")
                  .setStyle(TextInputStyle.Short)
                  .setPlaceholder("Contoh: 2")
                  .setMaxLength(3)
                  .setRequired(true),
              ),
            ),
        );
        return;
      case BUTTON_IDS.growId:
        await interaction.showModal(
          new ModalBuilder()
            .setCustomId(MODAL_IDS.growId)
            .setTitle("Set GrowID")
            .addComponents(
              modalRow(
                new TextInputBuilder()
                  .setCustomId("grow_id")
                  .setLabel("Input Account Name")
                  .setStyle(TextInputStyle.Short)
                  .setMinLength(3)
                  .setMaxLength(18)
                  .setRequired(true),
              ),
              modalRow(
                new TextInputBuilder()
                  .setCustomId("grow_id_confirm")
                  .setLabel("Confirm Account Name")
                  .setStyle(TextInputStyle.Short)
                  .setMinLength(3)
                  .setMaxLength(18)
                  .setRequired(true),
              ),
            ),
        );
        return;
      case BUTTON_IDS.balance:
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
        await this.showBalance(interaction);
        return;
      case BUTTON_IDS.depositWorld:
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
        await this.showDepositWorld(interaction);
        return;
      case BUTTON_IDS.qris:
        await interaction.showModal(
          new ModalBuilder()
            .setCustomId(MODAL_IDS.qris)
            .setTitle("QRIS TopUp")
            .addComponents(
              modalRow(
                new TextInputBuilder()
                  .setCustomId("amount_idr")
                  .setLabel("Nominal Rupiah")
                  .setStyle(TextInputStyle.Short)
                  .setPlaceholder(`Minimal ${this.config.topup.minimumIdr}`)
                  .setMaxLength(10)
                  .setRequired(true),
              ),
            ),
        );
    }
  }

  private async handleModal(
    interaction: ModalSubmitInteraction,
  ): Promise<void> {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    switch (interaction.customId) {
      case MODAL_IDS.growId:
        await this.submitGrowId(interaction);
        break;
      case MODAL_IDS.buy:
        await this.submitPurchase(interaction);
        break;
      case MODAL_IDS.qris:
        await this.submitTopup(interaction);
        break;
    }
  }

  private async submitGrowId(
    interaction: ModalSubmitInteraction,
  ): Promise<void> {
    const growId = interaction.fields.getTextInputValue("grow_id").trim();
    const confirmation = interaction.fields
      .getTextInputValue("grow_id_confirm")
      .trim();
    if (growId.toLowerCase() !== confirmation.toLowerCase()) {
      await interaction.editReply("Konfirmasi GrowID tidak cocok.");
      return;
    }
    if (!GROW_ID_PATTERN.test(growId)) {
      await interaction.editReply(
        "GrowID harus 3-18 karakter dan hanya boleh berisi huruf atau angka.",
      );
      return;
    }
    await this.store.setGrowId(interaction.user.id, growId);
    await interaction.editReply(`GrowID berhasil diatur menjadi **${growId}**.`);
  }

  private async submitPurchase(
    interaction: ModalSubmitInteraction,
  ): Promise<void> {
    const code = interaction.fields.getTextInputValue("product_code");
    const amount = parsePositiveInteger(
      interaction.fields.getTextInputValue("amount"),
    );
    if (!amount || amount > 100) {
      await interaction.editReply("Amount harus berupa angka antara 1 dan 100.");
      return;
    }

    const result = await this.store.purchase(interaction.user.id, code, amount);
    const unitPriceLocks =
      result.unit_price_locks ?? Math.floor(result.total_price_locks / result.quantity);
    const purchasedAt = result.created_at && Number.isFinite(Date.parse(result.created_at))
      ? new Date(result.created_at)
      : new Date();
    const purchasedAtUnix = Math.floor(purchasedAt.getTime() / 1000);
    const deliveryText = result.delivered_items.join("\n");
    const buildAttachment = () =>
      new AttachmentBuilder(Buffer.from(deliveryText, "utf8"), {
        name: `order-${result.order_id}.txt`,
      });
    const receiptEmbed = new EmbedBuilder()
      .setColor(0x2ecc71)
      .setTitle("Pembelian Berhasil")
      .setDescription(
        [
          `Order: \`${result.order_id}\``,
          `Produk: **${result.product_name}**`,
          `Kode: **${result.product_code}**`,
          `Jumlah: **${result.quantity}**`,
          `Harga satuan: **${formatLockUnits(unitPriceLocks)}**`,
          `Total: **${formatLockUnits(result.total_price_locks)}**`,
          `Waktu beli: <t:${purchasedAtUnix}:F>`,
        ].join("\n"),
      )
      .addFields({
        name: "Catatan",
        value: "Detail item dikirim melalui DM. Jika DM tertutup, file akan ditampilkan di sini.",
      });
    const replyEmbed = new EmbedBuilder()
      .setColor(0x2ecc71)
      .setTitle("Pembelian Diproses")
      .setDescription(
        [
          `Order: \`${result.order_id}\``,
          `Produk: **${result.product_name}**`,
          `Kode: **${result.product_code}**`,
          `Jumlah: **${result.quantity}**`,
          `Total: **${formatLockUnits(result.total_price_locks)}**`,
          `Sisa saldo: **${formatLockUnits(result.balance_locks)}**`,
          "Detail barang dikirim via DM.",
        ].join("\n"),
      );

    let dmSent = false;
    try {
      const user = await this.client.users.fetch(interaction.user.id);
      await user.send({
        embeds: [receiptEmbed],
        files: [buildAttachment()],
      });
      dmSent = true;
    } catch (error) {
      console.error("Gagal mengirim DM pembelian:", error);
    }

    await interaction.editReply({
      content: dmSent
        ? "Detail pembelian sudah dikirim lewat DM."
        : "DM gagal dikirim, jadi detail pembelian saya lampirkan di sini.",
      embeds: [dmSent ? replyEmbed : receiptEmbed],
      files: dmSent ? [] : [buildAttachment()],
    });
    void this.grantPurchaseRoles({
      discordId: interaction.user.id,
      guildId: interaction.guildId,
    }).catch((error) => console.error("Gagal memberikan role pembeli:", error));
    void this.logPurchase({
      discordId: interaction.user.id,
      orderId: result.order_id,
      productName: result.product_name,
      productCode: result.product_code,
      quantity: result.quantity,
      totalPriceLocks: result.total_price_locks,
    }).catch((error) => console.error("Gagal menulis buy log:", error));
    void this.updateLiveStock();
  }

  private async submitTopup(
    interaction: ModalSubmitInteraction,
  ): Promise<void> {
    if (!this.config.midtrans.enabled) {
      await interaction.editReply(
        "QRIS TopUp belum diaktifkan oleh admin.",
      );
      return;
    }

    const amountIdr = parsePositiveInteger(
      interaction.fields.getTextInputValue("amount_idr"),
    );
    if (
      !amountIdr ||
      amountIdr < this.config.topup.minimumIdr ||
      amountIdr > this.config.topup.maximumIdr
    ) {
      await interaction.editReply(
        `Nominal harus antara ${formatIdr(this.config.topup.minimumIdr)} dan ${formatIdr(this.config.topup.maximumIdr)}.`,
      );
      return;
    }

    const rate = await this.store.getSetting<number>("dl_rate_idr_per_dl");
    const creditedLocks = locksFromIdr(amountIdr, rate);
    if (creditedLocks < 1) {
      await interaction.editReply("Nominal terlalu kecil untuk rate saat ini.");
      return;
    }

    const feeIdr = calculateFee(amountIdr, this.config.midtrans.feePercent);
    const grossAmountIdr = amountIdr + feeIdr;
    const orderId = `OST-${Date.now()}-${randomBytes(3).toString("hex")}`;
    const expiresAt = new Date(
      Date.now() + this.config.midtrans.expiryMinutes * 60_000,
    );

    await this.store.createTopup({
      discordId: interaction.user.id,
      orderId,
      amountIdr,
      feeIdr,
      grossAmountIdr,
      amountLocks: creditedLocks,
      expiresAt,
    });

    try {
      const charge = await this.midtrans.chargeQris({
        orderId,
        grossAmountIdr,
        discordId: interaction.user.id,
      });
      await this.store.updateTopupGateway(
        orderId,
        charge.transactionId,
        charge.qrUrl,
        charge.raw,
      );
      console.info(
        `[Midtrans QR] order_id=${charge.orderId} transaction_id=${charge.transactionId} qr_url=${charge.qrUrl} amount_idr=${amountIdr} fee_idr=${feeIdr} gross_amount_idr=${grossAmountIdr} credited_locks=${creditedLocks}`,
      );
      await interaction.editReply({
        embeds: [
          new EmbedBuilder()
            .setColor(0x2ecc71)
            .setTitle("QRIS Top-Up")
            .setDescription(
              [
                `Transaction Code: \`${orderId}\``,
                `Midtrans ID: \`${charge.transactionId}\``,
                `Nominal saldo: **${formatIdr(amountIdr)}**`,
                `Biaya QRIS: **${formatIdr(feeIdr)}**`,
                `Total bayar: **${formatIdr(grossAmountIdr)}**`,
                `Saldo masuk: **${formatLockUnits(creditedLocks)}**`,
                `Kedaluwarsa: <t:${Math.floor(expiresAt.getTime() / 1000)}:R>`,
              ].join("\n"),
            )
            .setImage(charge.qrUrl),
        ],
      });
    } catch (error) {
      await this.store.markTopupFailed(orderId, {
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }

  private async showBalance(interaction: ButtonInteraction): Promise<void> {
    const user = await this.store.getUser(interaction.user.id);
    await interaction.editReply({
      embeds: [
        new EmbedBuilder()
          .setColor(0x3498db)
          .setTitle("Balance")
          .setDescription(
            [
              `GrowID: **${user?.grow_id ?? "Belum diatur"}**`,
              `Saldo aktif: **${formatLockUnits(user?.balance_locks ?? 0)}**`,
              `Total deposit: **${formatIdr(user?.total_deposit_idr ?? 0)}**`,
            ].join("\n"),
          ),
      ],
    });
  }

  private async showDepositWorld(
    interaction: ButtonInteraction,
  ): Promise<void> {
    const settings = await this.store.getStoreSettings();
    const deposit = settings.deposit_world;
    await interaction.editReply({
      embeds: [
        new EmbedBuilder()
          .setColor(0xf1c40f)
          .setTitle("Deposit World")
          .setDescription(
            [
              `World: **${deposit.world}**`,
              `Owner: **${deposit.owner}**`,
              `Bot in-game: **${deposit.bot_name}**`,
              "",
              `Peringatan: ${deposit.note}`,
            ].join("\n"),
          ),
      ],
    });
  }

  private async handleAdminCommand(
    interaction: ChatInputCommandInteraction,
  ): Promise<void> {
    if (!this.isAdmin(interaction)) {
      await interaction.reply({
        content: "Command ini hanya untuk admin.",
        flags: MessageFlags.Ephemeral,
      });
      return;
    }
    if (
      this.config.discord.adminChannelId &&
      interaction.channelId !== this.config.discord.adminChannelId
    ) {
      await interaction.reply({
        content: `Gunakan command ini di <#${this.config.discord.adminChannelId}>.`,
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const subcommand = interaction.options.getSubcommand();
    let response = "Selesai.";
    let refresh = false;

    switch (subcommand) {
      case "panel":
      case "refresh":
        await this.updateLiveStock();
        response = "Live stock berhasil diperbarui.";
        break;
      case "product-add": {
        const product = await this.store.createProduct({
          name: interaction.options.getString("name", true),
          code: interaction.options.getString("code", true),
          priceLocks: interaction.options.getInteger("price_locks", true),
          priceIdr: interaction.options.getInteger("price_idr"),
          description: interaction.options.getString("description") ?? "",
        });
        response = `Produk **${product.name} [${product.code}]** berhasil dibuat.`;
        refresh = true;
        break;
      }
      case "product-edit": {
        const update: ProductUpdate = {};
        const name = interaction.options.getString("name");
        const newCode = interaction.options.getString("new_code");
        const priceLocks = interaction.options.getInteger("price_locks");
        const priceIdr = interaction.options.getInteger("price_idr");
        const description = interaction.options.getString("description");
        const active = interaction.options.getBoolean("active");
        if (name !== null) update.name = name;
        if (newCode !== null) update.code = newCode;
        if (priceLocks !== null) update.priceLocks = priceLocks;
        if (priceIdr !== null) update.priceIdr = priceIdr;
        if (description !== null) update.description = description;
        if (active !== null) update.active = active;
        if (Object.keys(update).length === 0) {
          response = "Tidak ada perubahan yang diberikan.";
          break;
        }
        const product = await this.store.updateProduct(
          interaction.options.getString("code", true),
          update,
        );
        response = `Produk **${product.name} [${product.code}]** berhasil diubah.`;
        refresh = true;
        break;
      }
      case "product-delete": {
        const product = await this.store.deactivateProduct(
          interaction.options.getString("code", true),
        );
        response = `Produk **${product.name} [${product.code}]** dinonaktifkan.`;
        refresh = true;
        break;
      }
      case "stock-add": {
        const attachment = interaction.options.getAttachment("file", true);
        if (attachment.size > 1_000_000) {
          throw new Error("File stok maksimal 1 MB");
        }
        const stockResponse = await fetch(attachment.url);
        if (!stockResponse.ok) throw new Error("File stok gagal diunduh");
        const uniqueItems = [
          ...new Set(
            (await stockResponse.text())
              .split(/\r?\n/)
              .map((item) => item.trim())
              .filter(Boolean),
          ),
        ];
        if (uniqueItems.length === 0 || uniqueItems.length > 10_000) {
          throw new Error("File harus berisi 1 sampai 10.000 baris stok");
        }
        const inserted = await this.store.addStock(
          interaction.options.getString("code", true),
          uniqueItems,
        );
        response = `${inserted} stok baru berhasil ditambahkan (${uniqueItems.length - inserted} duplikat dilewati).`;
        refresh = true;
        break;
      }
      case "stock-view": {
        const stock = await this.store.getStockCount(
          interaction.options.getString("code", true),
        );
        response = [
          `**${stock.product.name} [${stock.product.code}]**`,
          `Tersedia: **${stock.available}**`,
          `Terjual: **${stock.sold}**`,
        ].join("\n");
        break;
      }
      case "set-rate": {
        const dlRate = interaction.options.getInteger("dl_rate", true);
        await Promise.all([
          this.store.setSetting("dl_rate_idr_per_dl", dlRate),
        ]);
        response = `Rate DL disimpan ke ${formatIdr(dlRate)}/DL.`;
        refresh = true;
        break;
      }
      case "add-balance": {
        const target = interaction.options.getUser("user", true);
        const note = interaction.options.getString("note") ?? undefined;
        const deltaLocks = getLockAmount(interaction);
        if (deltaLocks <= 0) {
          throw new Error("Tambahkan minimal 1 bgl, dl, atau wl");
        }
        const rate = await this.store.getSetting<number>("dl_rate_idr_per_dl");
        const deltaIdr = Math.round((deltaLocks / 100) * rate);
        const user = await this.store.addBalance({
          discordId: target.id,
          deltaLocks,
          deltaIdr,
          note,
          actorDiscordId: interaction.user.id,
        });
        response = [
          `Saldo untuk **${target.tag}** berhasil ditambah.`,
          `Tambahan: **${formatLockUnits(deltaLocks)}**`,
          `Saldo sekarang: **${formatLockUnits(user.balance_locks)}**`,
          `Perkiraan nilai rupiah: **${formatIdr(deltaIdr)}**`,
          note ? `Catatan: ${note}` : null,
        ]
          .filter(Boolean)
          .join("\n");
        void this.logDeposit({
          discordId: target.id,
          source: "MANUAL",
          amountIdr: deltaIdr,
          creditedLocks: deltaLocks,
          note,
        }).catch((error) => console.error("Gagal menulis deposit log:", error));
        refresh = true;
        break;
      }
      case "remove-balance": {
        const target = interaction.options.getUser("user", true);
        const note = interaction.options.getString("note") ?? undefined;
        const deltaLocks = getLockAmount(interaction);
        if (deltaLocks <= 0) {
          throw new Error("Kurangi minimal 1 bgl, dl, atau wl");
        }
        const rate = await this.store.getSetting<number>("dl_rate_idr_per_dl");
        const deltaIdr = Math.round((deltaLocks / 100) * rate);
        const user = await this.store.removeBalance({
          discordId: target.id,
          deltaLocks,
          deltaIdr,
          note,
          actorDiscordId: interaction.user.id,
        });
        response = [
          `Saldo untuk **${target.tag}** berhasil dikurangi.`,
          `Dikurangi: **${formatLockUnits(deltaLocks)}**`,
          `Saldo sekarang: **${formatLockUnits(user.balance_locks)}**`,
          `Perkiraan nilai rupiah: **${formatIdr(deltaIdr)}**`,
          note ? `Catatan: ${note}` : null,
        ]
          .filter(Boolean)
          .join("\n");
        refresh = true;
        break;
      }
      case "set-balance": {
        const target = interaction.options.getUser("user", true);
        const note = interaction.options.getString("note") ?? undefined;
        const balanceLocks = getLockAmount(interaction);
        const current = await this.store.getUser(target.id);
        const previousLocks = current?.balance_locks ?? 0;
        const deltaLocks = balanceLocks - previousLocks;
        const rate = await this.store.getSetting<number>("dl_rate_idr_per_dl");
        const deltaIdr = Math.round((Math.abs(deltaLocks) / 100) * rate);
        const user = await this.store.setBalance({
          discordId: target.id,
          balanceLocks,
          deltaIdr,
          note,
          actorDiscordId: interaction.user.id,
        });
        response = [
          `Saldo untuk **${target.tag}** berhasil diset.`,
          `Saldo sebelumnya: **${formatLockUnits(previousLocks)}**`,
          `Saldo sekarang: **${formatLockUnits(user.balance_locks)}**`,
          `Perubahan: **${formatLockUnits(Math.abs(deltaLocks))}** ${
            deltaLocks >= 0 ? "ditambah" : "dikurangi"
          }`,
          `Perkiraan nilai perubahan: **${formatIdr(deltaIdr)}**`,
          note ? `Catatan: ${note}` : null,
        ]
          .filter(Boolean)
          .join("\n");
        refresh = true;
        break;
      }
      case "set-deposit-world": {
        await this.store.setSetting("deposit_world", {
          world: interaction.options.getString("world", true).toUpperCase(),
          owner: interaction.options.getString("owner", true),
          bot_name: interaction.options.getString("bot_name", true),
          note:
            interaction.options.getString("note") ??
            "Jangan donasi jika bot yang berada di world bukan bot resmi toko.",
        });
        response = "Informasi deposit world berhasil diperbarui.";
        break;
      }
      case "confirm-payment":
        response = await this.confirmPayment(interaction);
        break;
    }

    if (refresh) void this.updateLiveStock();
    await interaction.editReply(response);
  }

  private async confirmPayment(
    interaction: ChatInputCommandInteraction,
  ): Promise<string> {
    const orderId = interaction.options.getString("order_id", true);
    const force = interaction.options.getBoolean("force") ?? false;
    if (!force && !this.config.midtrans.enabled) {
      throw new Error(
        "Midtrans belum aktif. Gunakan force hanya setelah pembayaran diverifikasi manual.",
      );
    }
    const transaction = await this.store.getTransaction(orderId);
    if (!transaction) throw new Error("Transaksi top-up tidak ditemukan");

    const status: MidtransNotification = force
      ? {
          order_id: orderId,
          status_code: "200",
          signature_key: "manual-admin-override",
          transaction_id:
            transaction.midtrans_transaction_id ?? `manual-${Date.now()}`,
          transaction_status: "settlement",
          gross_amount: `${transaction.gross_amount_idr}.00`,
        }
      : await this.midtrans.getStatus(orderId);

    if (!force && !this.midtrans.isSuccessful(status)) {
      throw new Error(`Status Midtrans masih ${status.transaction_status}`);
    }

    const result = await this.store.settleTopup({
      orderId,
      midtransTransactionId: status.transaction_id,
      transactionStatus: status.transaction_status,
      grossAmountIdr: transaction.gross_amount_idr,
      payload: status,
      force,
    });
    if (!result.already_credited) {
      await this.notifyPayment(result).catch(() => null);
    }
    return result.already_credited
      ? "Transaksi tersebut sudah pernah dikreditkan."
      : `Pembayaran dikonfirmasi. Saldo masuk ${formatLockUnits(result.credited_locks)}.`;
  }

  private isAdmin(interaction: ChatInputCommandInteraction): boolean {
    if (interaction.memberPermissions?.has(PermissionFlagsBits.Administrator)) {
      return true;
    }
    const member = interaction.member;
    if (!member || !("roles" in member)) return false;
    const roles = member.roles;
    if (Array.isArray(roles)) {
      return roles.some((roleId) =>
        this.config.discord.adminRoleIds.includes(roleId),
      );
    }
    return roles.cache.some((role) =>
      this.config.discord.adminRoleIds.includes(role.id),
    );
  }
}

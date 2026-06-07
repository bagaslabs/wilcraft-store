import { loadConfig } from "./config";
import { createDatabaseClient } from "./database";
import { StoreBot } from "./discord/bot";
import { StoreRepository } from "./repositories/store";
import { createServer } from "./server";
import { MidtransService } from "./services/midtrans";

const config = loadConfig();
const database = createDatabaseClient(config);
const store = new StoreRepository(database);
const midtrans = new MidtransService(config.midtrans);
const bot = new StoreBot(config, store, midtrans);
const app = createServer({
  config,
  store,
  midtrans,
  notifyPayment: (result) => bot.notifyPayment(result),
}).listen({
  hostname: config.host,
  port: config.port,
});

await bot.start();

console.log(
  `${config.storeName} API aktif di http://${config.host}:${app.server?.port}`,
);

async function shutdown(signal: string): Promise<void> {
  console.log(`Menerima ${signal}, menghentikan aplikasi...`);
  await bot.stop();
  await app.stop();
  process.exit(0);
}

process.once("SIGINT", () => void shutdown("SIGINT"));
process.once("SIGTERM", () => void shutdown("SIGTERM"));

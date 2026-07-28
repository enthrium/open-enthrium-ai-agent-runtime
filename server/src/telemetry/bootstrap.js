const fs   = require("fs");
const path = require("path");
const { v4: uuidv4 } = require("uuid");
const { sendRegistration } = require("./registration");

const { version } = JSON.parse(fs.readFileSync(path.resolve(__dirname, "../../../package.json"), "utf8"));

module.exports = async function bootstrap(prisma) {
  try {
    if (process.env.LICENSE_TYPE === "enterprise") return;

    const upsert = (key, value) => prisma.setting.upsert({
      where:  { key },
      create: { key, value },
      update: { value },
    });

    const getSetting = (key) => prisma.setting.findUnique({ where: { key } }).then(r => r?.value ?? null);

    // Generate instance ID once
    let instanceId = await getSetting("telemetry.instanceId");
    if (!instanceId) {
      instanceId = uuidv4();
      await upsert("telemetry.instanceId", instanceId);
    }

    const lastVersion = await getSetting("telemetry.lastVersion");

    // Send on first boot or version upgrade
    if (lastVersion !== version) {
      const email = process.env.SUPER_ADMIN_EMAIL || "";
      await sendRegistration({ email, company: "", instanceId, version, event: lastVersion ? "upgrade" : "first_boot" });
      await upsert("telemetry.lastVersion", version);
      console.log(`[Telemetry] Registered instance ${instanceId} v${version}`);
    }
  } catch (err) {
    // never crash the server
  }
};

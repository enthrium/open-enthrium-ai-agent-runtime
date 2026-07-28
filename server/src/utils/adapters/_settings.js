const { PrismaClient } = require("@prisma/client");
const db = new PrismaClient();
module.exports = async function getSetting(key) {
  const s = await db.setting.findUnique({ where: { key } });
  return s?.value || null;
};

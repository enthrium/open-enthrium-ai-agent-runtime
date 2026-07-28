const { PrismaClient } = require('@prisma/client');
const db = new PrismaClient();
db.connectionMaster.findMany({ select: { key: true, adapterType: true } })
  .then(rows => {
    // Group by adapterType
    const byAdapter = {};
    rows.forEach(r => {
      if (!byAdapter[r.adapterType]) byAdapter[r.adapterType] = [];
      byAdapter[r.adapterType].push(r.key);
    });
    Object.entries(byAdapter).forEach(([at, keys]) => {
      console.log(`\nadapterType="${at}" (${keys.length}):`);
      keys.slice(0, 10).forEach(k => console.log('  -', k));
      if (keys.length > 10) console.log('  ... +', keys.length - 10, 'more');
    });
    return db.$disconnect();
  });

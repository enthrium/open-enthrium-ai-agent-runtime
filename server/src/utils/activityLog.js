async function logActivity(db, user, action, details = {}) {
  try {
    await db.activityLog.create({
      data: {
        userId:    user?.id    || null,
        userEmail: user?.email || null,
        action,
        details: Object.keys(details).length > 0 ? JSON.stringify(details) : null
      }
    });
  } catch (e) {
    console.error("Activity log failed:", e.message);
  }
}

module.exports = { logActivity };

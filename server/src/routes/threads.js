const router = require("express").Router();
const { authenticate } = require("../middleware/auth");
const { v4: uuidv4 } = require("uuid");

router.get("/:slug", authenticate, async (req, res) => {
  const workspace = await req.db.workspace.findUnique({ where: { slug: req.params.slug } });
  if (!workspace) return res.status(404).json({ error: "Workspace not found" });
  const threads = await req.db.thread.findMany({
    where: { workspaceId: workspace.id },
    orderBy: [{ pinned: "desc" }, { createdAt: "desc" }]
  });
  res.json({ threads });
});

router.post("/:slug", authenticate, async (req, res) => {
  const { name } = req.body;
  const workspace = await req.db.workspace.findUnique({ where: { slug: req.params.slug } });
  if (!workspace) return res.status(404).json({ error: "Workspace not found" });
  const thread = await req.db.thread.create({
    data: { uid: uuidv4(), workspaceId: workspace.id, name: name || "New Thread" }
  });
  res.json({ thread });
});

router.put("/:slug/:uid/pin", authenticate, async (req, res) => {
  const thread = await req.db.thread.findUnique({ where: { uid: req.params.uid } });
  if (!thread) return res.status(404).json({ error: "Thread not found" });
  const updated = await req.db.thread.update({
    where: { uid: req.params.uid },
    data: { pinned: !thread.pinned }
  });
  res.json({ thread: updated });
});

router.put("/:slug/:uid", authenticate, async (req, res) => {
  const { name } = req.body;
  if (!name?.trim()) return res.status(400).json({ error: "Name required" });
  const thread = await req.db.thread.update({
    where: { uid: req.params.uid },
    data: { name: name.trim() }
  });
  res.json({ thread });
});

router.delete("/:slug/:uid", authenticate, async (req, res) => {
  const thread = await req.db.thread.findUnique({ where: { uid: req.params.uid } });
  if (!thread) return res.status(404).json({ error: "Thread not found" });
  await req.db.chat.deleteMany({ where: { threadId: thread.id } });
  await req.db.thread.delete({ where: { uid: req.params.uid } });
  res.json({ success: true });
});

module.exports = router;

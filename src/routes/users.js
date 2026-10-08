// Admin API (Admin role only): users and the activity log
const { HttpError } = require("../http-error");
const { log } = require("../log");

function registerUserRoutes(app, { users, audit, requireAdmin }) {
  const fail = (res, err) => {
    if (err instanceof HttpError) return res.status(err.status).json({ error: err.message });
    log.error("Users", "Save failed:", err);
    res.status(502).json({ error: "Não foi possível salvar os usuários. Tente de novo." });
  };

  app.get("/api/users", requireAdmin, (req, res) => res.json(users.list()));

  app.post("/api/users", requireAdmin, async (req, res) => {
    const { name, password, role } = req.body || {};
    try {
      await users.create({ name, password, role });
      res.status(201).json({ success: true, name, role });
    } catch (err) {
      fail(res, err);
    }
  });

  app.patch("/api/users/:name", requireAdmin, async (req, res) => {
    const { role, password } = req.body || {};
    try {
      await users.update(req.params.name, { role, password });
      res.json({ success: true, name: req.params.name });
    } catch (err) {
      fail(res, err);
    }
  });

  app.delete("/api/users/:name", requireAdmin, async (req, res) => {
    try {
      await users.remove(req.params.name, req.user.name);
      res.json({ success: true, name: req.params.name });
    } catch (err) {
      fail(res, err);
    }
  });

  // Activity log, newest first (this month and the previous one)
  app.get("/api/audit", requireAdmin, async (req, res) => {
    try {
      const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 300, 1), 1000);
      res.json({ entries: await audit.read(limit) });
    } catch (err) {
      log.error("Audit", "Read failed:", err);
      res.status(502).json({ error: "Não foi possível ler o registro de atividades" });
    }
  });
}

module.exports = { registerUserRoutes };

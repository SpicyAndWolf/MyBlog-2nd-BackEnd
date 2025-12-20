const db = require("../db");

const userModel = {
  async findByUsername(username) {
    const query = "SELECT * FROM users WHERE username = $1";
    const { rows } = await db.query(query, [username]);
    return rows[0];
  },

  async findById(id) {
    const query = "SELECT id, username, avatar_url, created_at FROM users WHERE id = $1";
    const { rows } = await db.query(query, [id]);
    return rows[0] || null;
  },
};

module.exports = userModel;

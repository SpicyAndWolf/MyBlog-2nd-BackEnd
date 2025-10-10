const db = require("../db");

const userModel = {
  async findByUsername(username) {
    const query = "SELECT * FROM users WHERE username = $1";
    const { rows } = await db.query(query, [username]);
    return rows[0];
  },
};

module.exports = userModel;

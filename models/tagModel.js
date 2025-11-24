const db = require("../db");

const tagModel = {
  // 查找所有标签 + 每个标签绑定的文章数量
  async findAll() {
    const query = "SELECT * FROM tags ORDER BY name";
    const { rows } = await db.query(query);
    return rows;
  },

  // (后台管理) 创建一个新标签
  async create({ name, parent_id = null }) {
    const query = `
      INSERT INTO tags (name, parent_id)
      VALUES ($1, $2)
      RETURNING *;
    `;
    const { rows } = await db.query(query, [name, parent_id]);
    return rows[0];
  },

  // (后台管理) 更新一个标签的名称
  async update(id, { name }) {
    const query = `
      UPDATE tags
      SET name = $1
      WHERE id = $2
      RETURNING *;
    `;
    const { rows } = await db.query(query, [name, id]);
    return rows[0];
  },

  // 检查一个标签被多少篇文章使用
  async getArticleCountByTagId(tagId) {
    const query = "SELECT COUNT(*) FROM article_tags WHERE tag_id = $1";
    const { rows } = await db.query(query, [tagId]);
    return parseInt(rows[0].count, 10);
  },

  // (后台管理) 删除一个标签
  async remove(id) {
    // 提醒：根据我们的表结构，删除父标签时，其子标签的 parent_id 会被设为 NULL，
    // 这意味着它们会变成顶层标签。这是由 ON DELETE SET NULL 约束控制的。
    const query = "DELETE FROM tags WHERE id = $1";
    const { rowCount } = await db.query(query, [id]);
    return rowCount;
  },
};

module.exports = tagModel;

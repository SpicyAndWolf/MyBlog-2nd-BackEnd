// controllers/articleController.js
const articleModel = require("@models/articleModel");
const { stripHtml } = require("string-strip-html");

const articleController = {
  // 获取所有已发布的文章列表
  async getAllPublishedArticles(req, res) {
    try {
      const { topTag, subTag, year, month, page, limit } = req.query;

      // 组合筛选条件
      const filters = {};
      if (subTag) filters.tag = subTag; // 优先使用子标签筛选
      else if (topTag) filters.tag = topTag;
      if (year) filters.year = parseInt(year, 10);
      if (month) filters.month = parseInt(month, 10);

      // 解析分页参数
      const pageNum = parseInt(page, 10) || 1;
      const limitNum = parseInt(limit, 10) || 10;

      const result = await articleModel.findPublished({
        filters,
        page: pageNum,
        limit: limitNum,
      });

      res.status(200).json(result);
    } catch (error) {
      console.error("Error in articleController.getAllPublishedArticles:", error);
      res.status(500).json({ error: "Internal Server Error" });
    }
  },

  // 获取单篇已发布的文章详情
  async getPublishedArticleById(req, res) {
    try {
      const { id } = req.params; // 从 URL 中获取文章 ID
      const article = await articleModel.findPublishedById(id);

      if (!article) {
        // 如果模型没有返回文章，说明文章不存在或未发布
        return res.status(404).json({ error: "Article not found" });
      }

      res.status(200).json(article);
    } catch (error) {
      console.error("Error in articleController.getPublishedArticleById:", error);
      res.status(500).json({ error: "Internal Server Error" });
    }
  },

  // (后台管理) 获取所有文章列表
  async getAllArticlesAdmin(req, res) {
    try {
      const { search, page, limit } = req.query;
      const result = await articleModel.findAllAdmin({
        searchQuery: search,
        page: parseInt(page, 10) || 1,
        limit: parseInt(limit, 10) || 10,
      });
      res.status(200).json(result);
    } catch (error) {
      console.error("Error in articleController.getAllArticlesAdmin:", error);
      res.status(500).json({ error: "服务器内部错误" });
    }
  },

  // (后台管理) 创建一篇新文章
  async createArticle(req, res) {
    try {
      const { title, content, thumbnail_url, header_image_url, status, tag_ids } = req.body;

      // 1. 基本验证
      if (!title || !content || !status) {
        return res.status(400).json({ error: "标题、内容和状态是必填项" });
      }
      if (status !== "published" && status !== "draft") {
        return res.status(400).json({ error: "无效的状态值" });
      }

      // 2. 从中间件注入的 req.user 中获取作者ID
      const author_id = req.user.id;

      // 3. 生成摘要 (这里我们实践了之前的优化方案)
      const summary = stripHtml(content).result.substring(0, 200);

      // 4. 准备要存入数据库的数据
      const articleData = {
        title,
        content,
        summary,
        thumbnail_url: thumbnail_url || null,
        header_image_url: header_image_url || null,
        status,
        author_id,
        // 如果是直接发布，则记录发布时间
        published_at: status === "published" ? new Date() : null,
        tag_ids: tag_ids || [], // 确保 tag_ids 是个数组
      };

      // 5. 调用模型创建文章
      const newArticle = await articleModel.create(articleData);

      res.status(201).json({ message: "文章创建成功", article: newArticle });
    } catch (error) {
      console.error("Error in articleController.createArticle:", error);
      res.status(500).json({ error: "创建文章失败，服务器内部错误" });
    }
  },

  // (后台管理) 获取单篇文章详情
  async getArticleByIdAdmin(req, res) {
    try {
      const { id } = req.params;
      const article = await articleModel.findByIdAdmin(id);

      if (!article) {
        return res.status(404).json({ error: "找不到指定的文章" });
      }

      res.status(200).json(article);
    } catch (error) {
      console.error("Error in articleController.getArticleByIdAdmin:", error);
      res.status(500).json({ error: "服务器内部错误" });
    }
  },

  // (后台管理) 更新一篇文章
  async updateArticle(req, res) {
    try {
      const { id } = req.params;
      const { title, content, thumbnail_url, header_image_url, status, tag_ids } = req.body;

      if (!title || !content || !status) {
        return res.status(400).json({ error: "标题、内容和状态是必填项" });
      }

      // 重新生成摘要
      const summary = stripHtml(content).result.substring(0, 200);

      // 检查文章当前是否已发布，以决定是否更新发布时间
      const existingArticle = await articleModel.findByIdAdmin(id);
      if (!existingArticle) {
        return res.status(404).json({ error: "找不到要更新的文章" });
      }

      const articleData = {
        title,
        content,
        summary,
        thumbnail_url: thumbnail_url || null,
        header_image_url: header_image_url || null,
        status,
        // 关键逻辑：如果文章之前未发布，现在要发布，则设置新的发布时间
        // 否则保持原来的发布时间不变
        published_at:
          status === "published" && existingArticle.status !== "published" ? new Date() : existingArticle.published_at,
        tag_ids: tag_ids || [],
      };

      const updatedArticle = await articleModel.update(id, articleData);
      res.status(200).json({ message: "文章更新成功", article: updatedArticle });
    } catch (error) {
      console.error("Error in articleController.updateArticle:", error);
      res.status(500).json({ error: "更新文章失败，服务器内部错误" });
    }
  },

  // (后台管理) 删除一篇文章
  async deleteArticle(req, res) {
    try {
      const { id } = req.params;
      const deletedCount = await articleModel.remove(id);

      if (deletedCount === 0) {
        return res.status(404).json({ error: "找不到要删除的文章" });
      }

      // HTTP 204 No Content 是删除成功的标准响应，表示服务器成功处理请求但没有内容返回
      res.status(204).send();
    } catch (error) {
      console.error("Error in articleController.deleteArticle:", error);
      res.status(500).json({ error: "删除文章失败，服务器内部错误" });
    }
  },
};

module.exports = articleController;

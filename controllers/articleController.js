// controllers/articleController.js
const articleModel = require("@models/articleModel");
const { stripHtml } = require("string-strip-html");
const sharp = require("sharp");
const path = require("path");
const fs = require("fs");

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
      const { title, content, status, tag_ids } = req.body;

      // 基本检验
      if (!title || !content || !status) {
        return res.status(400).json({ error: "标题、内容和状态是必填项" });
      }
      if (status !== "published" && status !== "draft") {
        return res.status(400).json({ error: "无效的状态值" });
      }

      // 解析 tag_ids：前端以 JSON 字符串传上来
      let tagIdsArray = [];
      if (tag_ids) {
        try {
          tagIdsArray = JSON.parse(tag_ids);
          if (!Array.isArray(tagIdsArray)) {
            tagIdsArray = [];
          }
        } catch (e) {
          tagIdsArray = [];
        }
      }

      // 从中间件注入的 req.user 中获取作者ID
      const author_id = req.user.id;

      // 生成摘要
      const summary = stripHtml(content).result.substring(0, 200);

      // 处理头图文件
      let header_image_url = null;
      let thumbnail_url = null;

      const file = req.file;
      if (file) {
        // 根目录 /uploads/articles
        const uploadsRoot = path.join(__dirname, "..", "uploads", "articles");
        const headerDir = path.join(uploadsRoot, "headers");
        const thumbDir = path.join(uploadsRoot, "thumbnails");
        fs.mkdirSync(headerDir, { recursive: true });
        fs.mkdirSync(thumbDir, { recursive: true });

        const ext = path.extname(file.filename);
        const base = path.basename(file.filename, ext);

        const headerFilename = `${base}-header${ext}`;
        const thumbFilename = `${base}-thumb${ext}`;

        const headerFilePath = path.join(headerDir, headerFilename);
        const thumbFilePath = path.join(thumbDir, thumbFilename);

        // 生成头图（大图）
        await sharp(file.path)
          .resize({
            width: 2560,
            withoutEnlargement: true, // 如果原图小于最大尺寸，则保持原样，不强制拉大
          })
          .webp({ quality: 80 })
          .toFile(headerFilePath);

        // 生成缩略图
        await sharp(file.path)
          .resize({ width: 400 }) // 缩略图宽度
          .webp({ quality: 80 })
          .toFile(thumbFilePath);

        // 原始文件可以删掉（可选）
        fs.unlink(file.path, () => {});

        // 对前端暴露的 URL（注意：走 /uploads 静态目录）
        header_image_url = `/uploads/articles/headers/${headerFilename}`;
        thumbnail_url = `/uploads/articles/thumbnails/${thumbFilename}`;
      }

      // 准备要存入数据库的数据
      const articleData = {
        title,
        content,
        summary,
        thumbnail_url,
        header_image_url,
        status,
        author_id,
        published_at: status === "published" ? new Date() : null,
        tag_ids: tagIdsArray,
      };

      // 创建文章
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
      const { title, content, status } = req.body;

      if (!title || !content || !status) {
        return res.status(400).json({ error: "标题、内容和状态是必填项" });
      }

      // 解析 tag_ids（FormData 提交会是字符串）
      let tagIdsArray = [];
      if (req.body.tag_ids) {
        try {
          tagIdsArray = Array.isArray(req.body.tag_ids) ? req.body.tag_ids : JSON.parse(req.body.tag_ids);
          if (!Array.isArray(tagIdsArray)) tagIdsArray = [];
        } catch (e) {
          tagIdsArray = [];
        }
      }

      // 查询现有文章，便于保留旧值
      const existingArticle = await articleModel.findByIdAdmin(id);
      if (!existingArticle) {
        return res.status(404).json({ error: "找不到要更新的文章" });
      }

      // 基础字段
      const summary = stripHtml(content).result.substring(0, 200);
      let header_image_url = req.body.header_image_url || existingArticle.header_image_url || null;
      let thumbnail_url = req.body.thumbnail_url || existingArticle.thumbnail_url || null;

      // 如有新上传的头图，生成大图与缩略图
      if (req.file) {
        const uploadsRoot = path.join(__dirname, "..", "uploads", "articles");
        const headerDir = path.join(uploadsRoot, "headers");
        const thumbDir = path.join(uploadsRoot, "thumbnails");
        fs.mkdirSync(headerDir, { recursive: true });
        fs.mkdirSync(thumbDir, { recursive: true });

        const ext = path.extname(req.file.filename);
        const base = path.basename(req.file.filename, ext);

        const headerFilename = `${base}-header${ext}`;
        const thumbFilename = `${base}-thumb${ext}`;

        const headerFilePath = path.join(headerDir, headerFilename);
        const thumbFilePath = path.join(thumbDir, thumbFilename);

        await sharp(req.file.path)
          .resize({ width: 2560, withoutEnlargement: true })
          .webp({ quality: 80 })
          .toFile(headerFilePath);

        await sharp(req.file.path).resize({ width: 400 }).webp({ quality: 80 }).toFile(thumbFilePath);

        fs.unlink(req.file.path, () => {});

        header_image_url = `/uploads/articles/headers/${headerFilename}`;
        thumbnail_url = `/uploads/articles/thumbnails/${thumbFilename}`;
      }

      const articleData = {
        title,
        content,
        summary,
        thumbnail_url,
        header_image_url,
        status,
        published_at:
          status === "published" && existingArticle.status !== "published" ? new Date() : existingArticle.published_at,
        tag_ids: tagIdsArray,
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

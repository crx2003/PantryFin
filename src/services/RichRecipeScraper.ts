// src/services/RichRecipeScraper.ts
//
// v4.3 全图文排版保留食谱抓取引擎
// 3层漏斗: Layer 1 站点特化 → Layer 2 JSON-LD+DOM图文绑定 → Layer 3 AI兜底
// 内置防护: 懒加载属性提取 / DOMParser清洗 / 防盗链探测桩

import { UnitConverter } from "../nutrition/UnitConverter";
import type { ParsedIngredient } from "../nutrition/UnitConverter";
import type { AgyEngine } from "./AgyEngine";
import { RecipeScraper, type ScrapedRecipe } from "./RecipeScraper";

// ══════════════════════════════════════════════════════
//  类型定义
// ══════════════════════════════════════════════════════

export interface RichRecipeStep {
  number: number;
  text: string;
  images: string[];          // 该步骤的配图 URL 列表
}

export interface RichRecipe {
  name: string;
  description?: string;
  coverImage?: string;
  ingredients: ParsedIngredient[];
  steps: RichRecipeStep[];   // 核心: 每步文字+图片绑定
  tips?: string[];
  allImages: string[];       // 全量图片 URL 索引 (含封面+步骤图+独立图)
  sourceUrl?: string;
}

// ══════════════════════════════════════════════════════
//  防护 1: 全局懒加载图片提取
// ══════════════════════════════════════════════════════

function _extractRealSrc(img: Element): string {
  return img.getAttribute("data-src")
      || img.getAttribute("data-original")
      || img.getAttribute("data-actualsrc")
      || img.getAttribute("src")
      || "";
}

// ══════════════════════════════════════════════════════
//  防护 4: DOMParser 精准清洗 (供 Layer 3 AI 使用)
// ══════════════════════════════════════════════════════

function _cleanHtmlForAI(html: string): string {
  try {
    const doc = new DOMParser().parseFromString(html, "text/html");
    doc.querySelectorAll("script, style, nav, footer, header, iframe, noscript, .ad, .comment, .sidebar, .recommend")
       .forEach(el => el.remove());
    const main = doc.querySelector("article, main, [itemtype*='Recipe'], .recipe-content, .content, .recipe") || doc.body;
    return main.innerHTML.substring(0, 4000);
  } catch {
    // 回退: 简单正则清洗
    return html
      .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, "")
      .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, "")
      .replace(/<[^>]+>/g, " ")
      .replace(/\s{2,}/g, "\n")
      .trim()
      .substring(0, 3000);
  }
}

// ══════════════════════════════════════════════════════
//  站点域名检测
// ══════════════════════════════════════════════════════

function _detectSite(url: string): string | null {
  try {
    const host = new URL(url).hostname.replace("www.", "");
    if (host.includes("xiachufang")) return "xiachufang";
    if (host.includes("meishichina") || host.includes("meishi")) return "meishichina";
    if (host.includes("allrecipes")) return "allrecipes";
    if (host.includes("bbcgoodfood") || host.includes("bbc.co.uk/food")) return "bbc";
    return null;
  } catch {
    return null;
  }
}

// ══════════════════════════════════════════════════════
//  RichRecipeScraper 主类
// ══════════════════════════════════════════════════════

export class RichRecipeScraper {
  private converter: UnitConverter;
  private legacyScraper: RecipeScraper;  // 复用 JSON-LD 解析

  constructor() {
    this.converter = new UnitConverter();
    this.legacyScraper = new RecipeScraper();
  }

  // ── 公共 API ──────────────────────────────────

  /** 从 HTML 提取 RichRecipe (Layer 1 → Layer 2) */
  scrapeFromHtml(html: string, sourceUrl?: string): RichRecipe | null {
    const site = sourceUrl ? _detectSite(sourceUrl) : null;

    // Layer 1: 站点特化
    if (site) {
      const doc = new DOMParser().parseFromString(html, "text/html");
      if (site === "xiachufang") {
        const recipe = this._extractXiachufang(doc);
        if (recipe) { recipe.sourceUrl = sourceUrl; return recipe; }
      }
      if (site === "meishichina") {
        const recipe = this._extractMeishichina(doc);
        if (recipe) { recipe.sourceUrl = sourceUrl; return recipe; }
      }
    }

    // Layer 2: 通用提取 (JSON-LD + DOM 图文绑定)
    const doc = new DOMParser().parseFromString(html, "text/html");
    const recipe = this._extractGeneric(doc, html);
    if (recipe) { recipe.sourceUrl = sourceUrl; return recipe; }

    return null;
  }

  /** AI 兜底提取 (Layer 3) */
  async scrapeFromHtmlWithAI(html: string, agyEngine: AgyEngine, sourceUrl?: string): Promise<RichRecipe | null> {
    const cleaned = _cleanHtmlForAI(html);
    if (cleaned.length < 50) return null;

    const prompt = `从以下 HTML 提取完整食谱。保留所有图片 URL（注意 data-src/data-original 属性优先级高于 src）。
返回严格 JSON（不要用 \`\`\`json 包裹）：
{
  "name": "菜名",
  "coverImage": "封面图URL",
  "description": "简介",
  "ingredients": [{"name":"食材", "grams":克重}],
  "steps": [
    {"number": 1, "text": "步骤文字", "images": ["配图URL"]}
  ],
  "tips": ["小贴士"]
}

HTML: ${cleaned}`;

    try {
      const raw = await agyEngine.executeRaw(prompt);
      if (!raw) return null;
      const cleaned = raw.replace(/```json|```/g, "").trim();
      const parsed = JSON.parse(cleaned);
      if (!parsed.name) return null;

      const ingredients: ParsedIngredient[] = (parsed.ingredients || []).map((i: any) => {
        if (typeof i === "string") {
          const p = this.converter.parse(i.trim());
          return p && p.grams > 0 ? p : { name: i.trim(), grams: 0, originalText: i.trim() };
        }
        return { name: i.name, grams: i.grams || 0, originalText: `${i.name} ${i.grams || 0}g` };
      });

      const steps: RichRecipeStep[] = (parsed.steps || []).map((s: any) => ({
        number: s.number || 0,
        text: typeof s === "string" ? s : (s.text || ""),
        images: Array.isArray(s.images) ? s.images.map(_extractRealSrc).filter(Boolean) : [],
      }));

      const allImages: string[] = [];
      if (parsed.coverImage) allImages.push(parsed.coverImage);
      steps.forEach(s => allImages.push(...s.images));

      return {
        name: parsed.name,
        description: parsed.description,
        coverImage: parsed.coverImage,
        ingredients,
        steps,
        tips: parsed.tips || [],
        allImages: [...new Set(allImages)],
        sourceUrl,
      };
    } catch {
      return null;
    }
  }

  /** 将 RichRecipe 转为增强版 Markdown */
  static toMarkdown(recipe: RichRecipe, totalCalories: number): string {
    const frontmatterLines = [
      "---",
      `type: recipe`,
      `source: "${recipe.sourceUrl || ""}"`,
      `cover_image: "${recipe.coverImage || ""}"`,
      `description: "${(recipe.description || "").replace(/"/g, '\\"')}"`,
      `calories_total: ${totalCalories}`,
      `tips:`,
      ...(recipe.tips || []).map(t => `  - "${t.replace(/"/g, '\\"')}"`),
      `images:`,
      ...recipe.allImages.map(u => `  - "${u}"`),
      "---",
    ].join("\n");

    const coverBlock = recipe.coverImage
      ? `\n![${recipe.name}](${recipe.coverImage})\n`
      : "";

    const descBlock = recipe.description
      ? `\n> 📝 ${recipe.description}\n`
      : "";

    const sourceLink = recipe.sourceUrl
      ? `> 🌐 [原网页](${recipe.sourceUrl})  |  🔥 ~${totalCalories} kcal`
      : `> 🔥 ~${totalCalories} kcal`;

    // 食材表格
    const ingRows = recipe.ingredients.map(i => {
      const name = i.name || i.originalText || "";
      const grams = i.grams > 0 ? `${i.grams}g` : "-";
      return `| **${name}** | ${grams} | - |`;
    }).join("\n");

    // 步骤区 (对齐 MealPlanParser: ## 👨‍🍳 烹饪步骤)
    const stepBlocks = recipe.steps.map(s => {
      const imgs = s.images.map(u => `![步骤${s.number}](${u})`).join("\n");
      return [
        `### 步骤 ${s.number}`,
        imgs,
        `${s.number}. ${s.text}`,
      ].filter(Boolean).join("\n\n");
    }).join("\n\n");

    // 小贴士
    const tipsBlock = recipe.tips && recipe.tips.length > 0
      ? `\n---\n\n## 💡 小贴士\n\n${recipe.tips.map(t => `- ${t}`).join("\n")}\n`
      : "";

    return [
      frontmatterLines,
      "",
      coverBlock,
      `# ${recipe.name}`,
      "",
      sourceLink,
      descBlock,
      "",
      "---",
      "",
      "## 🥩 食材清单",
      "",
      "| 食材 | 用量 | 热量 |",
      "|:---|:---|:---|",
      ingRows,
      "",
      "---",
      "",
      "## 👨‍🍳 烹饪步骤",
      "",
      stepBlocks,
      tipsBlock,
    ].join("\n");
  }

  // ══════════════════════════════════════════════════════
  //  Layer 1: 站点特化提取器
  // ══════════════════════════════════════════════════════

  /** 下厨房 (xiachufang.com) */
  private _extractXiachufang(doc: Document): RichRecipe | null {
    try {
      const name = doc.querySelector("h1, .recipe-title, [class*='title']")?.textContent?.trim()
                || doc.querySelector("title")?.textContent?.replace(/[-–—].*/, "").trim()
                || "未知食谱";

      const coverImg = doc.querySelector(".cover-img img, .final-img img, .recipe-cover img");
      const coverImage = coverImg ? _extractRealSrc(coverImg) : undefined;

      // 食材
      const ingEls = doc.querySelectorAll(".ings tr, .ingredients li, [class*='ingredient']");
      const ingredients: ParsedIngredient[] = [];
      ingEls.forEach(el => {
        const text = el.textContent?.trim() || "";
        if (text && text.length > 1 && text.length < 100) {
          const parsed = this.converter.parse(text);
          if (parsed) ingredients.push(parsed);
        }
      });

      // 步骤: 每个 .cookstep 是一个步骤容器 (含图+文字)
      const stepEls = doc.querySelectorAll(".cookstep, .step, [class*='step']");
      const steps: RichRecipeStep[] = [];
      stepEls.forEach((el, idx) => {
        const imgs = Array.from(el.querySelectorAll("img")).map(_extractRealSrc).filter(Boolean);
        const textEl = el.querySelector("p") || el;
        const text = textEl.textContent?.trim() || "";
        if (text.length > 5) {
          steps.push({ number: idx + 1, text, images: imgs });
        }
      });

      // 小贴士
      const tipEls = doc.querySelectorAll(".tip, .tips, [class*='tip']");
      const tips = Array.from(tipEls).map(el => el.textContent?.trim() || "").filter(t => t.length > 2);

      // 全量图片
      const allImgs = doc.querySelectorAll("img");
      const allImages = Array.from(allImgs).map(_extractRealSrc).filter(u => u && u.startsWith("http"));

      // 描述
      const descEl = doc.querySelector(".desc, .intro, [class*='desc']");
      const description = descEl?.textContent?.trim() || undefined;

      return { name, description, coverImage, ingredients, steps, tips, allImages: [...new Set(allImages)] };
    } catch {
      return null;
    }
  }

  /** 美食天下 (meishichina.com) */
  private _extractMeishichina(doc: Document): RichRecipe | null {
    try {
      const name = doc.querySelector("h1, #recipe_title, .recipe-title")?.textContent?.trim()
                || doc.querySelector("title")?.textContent?.replace(/[-–—].*/, "").trim()
                || "未知食谱";

      const coverImg = doc.querySelector(".J_photo img, .recipe-pic img, .food-pic img");
      const coverImage = coverImg ? _extractRealSrc(coverImg) : undefined;

      // 食材 (通常在主料/辅料表格中)
      const ingEls = doc.querySelectorAll(".mainl dl dd, .category_s1 dd, [class*='material']");
      const ingredients: ParsedIngredient[] = [];
      ingEls.forEach(el => {
        const text = el.textContent?.trim() || "";
        if (text && text.length > 1) {
          const parsed = this.converter.parse(text);
          if (parsed) ingredients.push(parsed);
        }
      });

      // 步骤: .content 下的段落 (文字和图片交错)
      const contentEl = doc.querySelector(".content, .recipe-content, .detail-content");
      const paragraphs = contentEl?.querySelectorAll("p") || doc.querySelectorAll("article p");
      const steps: RichRecipeStep[] = [];
      let stepNum = 0;

      paragraphs.forEach(p => {
        const imgs = Array.from(p.querySelectorAll("img")).map(_extractRealSrc).filter(Boolean);
        const text = p.textContent?.trim() || "";

        if (imgs.length > 0 && text.length < 10) {
          // 纯图片段落: 作为下一步的配图暂存
          // (处理逻辑在下一步合并)
        }

        if (text.length >= 10) {
          stepNum++;
          // 检查前一个兄弟节点中的图片
          const prevImgs: string[] = [];
          let prev = p.previousElementSibling;
          while (prev && prev.tagName !== "P") {
            prev.querySelectorAll("img").forEach(i => {
              const u = _extractRealSrc(i);
              if (u) prevImgs.push(u);
            });
            prev = prev.previousElementSibling;
          }
          steps.push({
            number: stepNum,
            text,
            images: [...new Set([...prevImgs, ...imgs])],
          });
        }
      });

      // 小贴士
      const tipEls = doc.querySelectorAll(".tip, .tips, .notice, [class*='hint']");
      const tips = Array.from(tipEls).map(el => el.textContent?.trim() || "").filter(t => t.length > 2);

      const allImgs = doc.querySelectorAll("img");
      const allImages = Array.from(allImgs).map(_extractRealSrc).filter(u => u && u.startsWith("http"));

      const descEl = doc.querySelector(".intro, .summary");
      const description = descEl?.textContent?.trim() || undefined;

      return { name, description, coverImage, ingredients, steps, tips, allImages: [...new Set(allImages)] };
    } catch {
      return null;
    }
  }

  // ══════════════════════════════════════════════════════
  //  Layer 2: 通用提取 (JSON-LD + DOM 图文绑定)
  // ══════════════════════════════════════════════════════

  private _extractGeneric(doc: Document, rawHtml: string): RichRecipe | null {
    // 先用旧 RecipeScraper 提取 JSON-LD 结构化数据
    const legacy = this.legacyScraper.scrapeFromHtml(rawHtml);
    if (!legacy || legacy.ingredients.length === 0) return null;

    // 封面图: og:image → JSON-LD image → 第一个大图
    let coverImage = legacy.imageUrl;
    if (!coverImage) {
      const ogImg = doc.querySelector("meta[property='og:image']");
      coverImage = ogImg?.getAttribute("content") || undefined;
    }
    if (!coverImage) {
      const firstImg = doc.querySelector("img[src*='http']");
      coverImage = firstImg ? _extractRealSrc(firstImg) : undefined;
    }

    // 全量图片收集
    const allImgs = Array.from(doc.querySelectorAll("img"))
      .map(_extractRealSrc)
      .filter(u => u && u.startsWith("http"));

    // 步骤图文绑定: 扫描 DOM 中的步骤容器
    const stepCandidates = doc.querySelectorAll("ol li, .step, .cookstep, [class*='step'], .instruction");
    const richSteps: RichRecipeStep[] = [];
    let stepIdx = 0;

    if (stepCandidates.length > 0) {
      stepCandidates.forEach(el => {
        const text = el.textContent?.trim() || "";
        // 过滤非步骤内容 (导航、广告等)
        if (text.length < 15 || text.length > 500) return;
        if (/^(?:分享|收藏|评论|点赞|打印)/.test(text)) return;

        stepIdx++;
        const imgs = Array.from(el.querySelectorAll("img"))
          .map(_extractRealSrc)
          .filter(Boolean);

        // 也扫描紧邻的同级图片
        let sibling = el.previousElementSibling;
        while (sibling && sibling.tagName === "IMG") {
          const u = _extractRealSrc(sibling);
          if (u) imgs.unshift(u);
          sibling = sibling.previousElementSibling;
        }

        richSteps.push({ number: stepIdx, text, images: [...new Set(imgs)] });
      });
    }

    // 如果 DOM 扫描无步骤 → 用 JSON-LD 的纯文字步骤
    if (richSteps.length === 0 && legacy.steps.length > 0) {
      legacy.steps.forEach((text, i) => {
        richSteps.push({ number: i + 1, text, images: [] });
      });
    }

    return {
      name: legacy.name,
      description: legacy.description,
      coverImage,
      ingredients: legacy.ingredients,
      steps: richSteps,
      tips: legacy.tips,
      allImages: [...new Set(allImgs)],
    };
  }
}

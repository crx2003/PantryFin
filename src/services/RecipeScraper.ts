// src/services/RecipeScraper.ts
//
// JSON-LD 食谱解析器 v1.1（本土化增强版 + AI 兜底）
// 支持中英文多键别名 + 单字符串自愈切分 + BFS 节点搜索 + AI 降级提取

import { UnitConverter } from "../nutrition/UnitConverter";
import type { ParsedIngredient } from "../nutrition/UnitConverter";
import type { AgyEngine } from "./AgyEngine";

// ── 多语言键名嗅探表 ──────────────────────────────
const INGREDIENT_KEYS = [
  "recipeIngredient", "ingredients", "配料", "食材", "用料", "准备食材", "原料",
  "主料", "辅料", "调料",
];
const INSTRUCTION_KEYS = [
  "recipeInstructions", "instructions", "步骤", "做法", "烹饪步骤", "制作方法",
  "recipeInstruction", "instruction", "操作步骤",
];
const IMAGE_KEYS = ["image", "photo", "thumbnailUrl", "imageUrl", "图片", "照片", "封面"];
const NAME_KEYS = ["name", "title", "recipeName", "菜名", "菜谱名", "名称", "标题"];
const DESCRIPTION_KEYS = ["description", "简介", "描述", "摘要", "介绍"];
const RECIPE_TYPE_VALUES = ["Recipe", "食谱", "菜谱"];

// 小贴士区块关键词（中英文）
const TIPS_SECTION_RE = /(?:小贴[士示]|烹饪技巧?|tips?|cooking\s*tips?|厨艺秘诀?|小窍门)/i;
const TIPS_LIST_RE = /<li[^>]*>([\s\S]*?)<\/li>/gi;

// ── 单字符串切分正则 ──────────────────────────────
const SPLIT_RE = /[\n，,、；;。．.·••‣◦]|\s{2,}/;

export interface ScrapedRecipe {
  name: string;
  ingredients: ParsedIngredient[];
  steps: string[];
  sourceUrl?: string;
  imageUrl?: string;
  description?: string;    // v4.2: 菜谱简介（JSON-LD description 字段）
  tips?: string[];          // v4.2: 烹饪小贴士（HTML 小贴士/Tips 区块）
}

// ══════════════════════════════════════════════════════
//  公共 API
// ══════════════════════════════════════════════════════

export class RecipeScraper {
  private converter: UnitConverter;

  constructor() {
    this.converter = new UnitConverter();
  }

  /** 从 HTML 文本中提取食谱（JSON-LD 优先） */
  scrapeFromHtml(html: string, sourceUrl?: string): ScrapedRecipe | null {
    // 1. 尝试从 JSON-LD 提取
    const jsonLd = this._extractJsonLd(html);
    if (jsonLd) {
      const recipe = this._parseJsonLdRecipe(jsonLd);
      if (recipe) {
        recipe.sourceUrl = sourceUrl;
        // v4.2: 补充提取 HTML 中的小贴士和图片
        recipe.tips = this._extractTipsFromHtml(html);
        if (!recipe.imageUrl) {
          recipe.imageUrl = this._extractFirstImageFromHtml(html);
        }
        return recipe;
      }
    }
    return null;
  }

  /** 直接解析 JSON-LD 对象（用于测试） */
  parseJsonLd(json: any, sourceUrl?: string): ScrapedRecipe | null {
    const recipe = this._parseJsonLdRecipe(json);
    if (recipe) recipe.sourceUrl = sourceUrl;
    return recipe;
  }

  // ══════════════════════════════════════════════════════
  //  内部方法
  // ══════════════════════════════════════════════════════

  /** 从 HTML 中提取所有 JSON-LD 块 */
  private _extractJsonLd(html: string): any | null {
    const re = /<script[^>]*type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/gi;
    const blocks: any[] = [];
    let m: RegExpExecArray | null;
    while ((m = re.exec(html)) !== null) {
      try {
        const parsed = JSON.parse(m[1]!);
        blocks.push(parsed);
      } catch { /* 跳过无效 JSON */ }
    }
    // 合并所有块为一个数组做 BFS
    return blocks.length === 1 ? blocks[0] : blocks;
  }

  /** BFS 搜索 @type=Recipe 节点 */
  private _findRecipeNode(root: any): any | null {
    if (!root || typeof root !== "object") return null;
    const queue = [root];
    const visited = new Set<any>();
    while (queue.length > 0) {
      const node = queue.shift()!;
      if (visited.has(node)) continue;
      visited.add(node);
      if (typeof node === "object" && node !== null) {
        // 检查 @type
        if (RECIPE_TYPE_VALUES.includes(node["@type"])) return node;
        // 检查 graph 数组
        if (Array.isArray(node["@graph"])) {
          for (const item of node["@graph"]) {
            if (RECIPE_TYPE_VALUES.includes(item["@type"])) return item;
          }
        }
        // 递归搜索
        for (const v of Object.values(node)) {
          if (typeof v === "object" && v !== null && !visited.has(v)) {
            queue.push(v);
          }
        }
      }
    }
    return null;
  }

  /** 多键名模糊匹配：用多个候选键在对象中查找值 */
  private _sniffField(obj: any, keys: string[]): any {
    for (const key of keys) {
      if (obj[key] !== undefined && obj[key] !== null && obj[key] !== "") {
        return obj[key];
      }
    }
    return null;
  }

  /** 解析 Recipe 节点 → ScrapedRecipe */
  private _parseJsonLdRecipe(ldObject: any): ScrapedRecipe | null {
    const recipeNode = this._findRecipeNode(ldObject);
    if (!recipeNode) return null;

    // 菜名
    const name = this._sniffField(recipeNode, NAME_KEYS) || "未知食谱";

    // 食材
    const rawIngs = this._sniffField(recipeNode, INGREDIENT_KEYS);
    let ingStrings: string[] = [];
    if (typeof rawIngs === "string") {
      // 单字符串自愈切分
      ingStrings = rawIngs.split(SPLIT_RE).map(s => s.trim()).filter(s => s.length > 0);
    } else if (Array.isArray(rawIngs)) {
      ingStrings = rawIngs.map(String).map(s => s.trim()).filter(s => s.length > 0);
    } else if (rawIngs) {
      ingStrings = [String(rawIngs)];
    }

    const ingredients: ParsedIngredient[] = [];
    for (const s of ingStrings) {
      const parsed = this.converter.parse(s);
      if (parsed && parsed.grams > 0) {
        ingredients.push(parsed);
      } else if (parsed && parsed.grams === 0) {
        // 保留原始文本，标记为未解析
        ingredients.push({ name: s, grams: 0, originalText: s });
      }
    }

    // 步骤
    const rawSteps = this._sniffField(recipeNode, INSTRUCTION_KEYS);
    let stepStrings: string[] = [];
    if (typeof rawSteps === "string") {
      // 尝试按 HowToStep 结构提取
      stepStrings = rawSteps.split(SPLIT_RE).map(s => s.trim()).filter(s => s.length > 0);
    } else if (Array.isArray(rawSteps)) {
      stepStrings = rawSteps.map((s: any) => {
        if (typeof s === "string") return s.trim();
        if (s?.text) return s.text.trim();
        if (s?.description) return s.description.trim();
        return String(s).trim();
      }).filter((s: string) => s.length > 0);
    }

    // 提取图片 URL（支持字符串/对象/数组三种 JSON-LD 格式）
    let imageUrl: string | undefined;
    const rawImg = this._sniffField(recipeNode, IMAGE_KEYS);
    if (typeof rawImg === "string") imageUrl = rawImg;
    else if (rawImg?.url) imageUrl = rawImg.url;
    else if (Array.isArray(rawImg) && rawImg.length > 0) {
      imageUrl = typeof rawImg[0] === "string" ? rawImg[0] : rawImg[0]?.url;
    }

    // v4.2: 提取菜谱简介
    const description = this._sniffField(recipeNode, DESCRIPTION_KEYS) || undefined;

    return { name, ingredients, steps: stepStrings, imageUrl, description };
  }

  // ══════════════════════════════════════════════════════
  //  AI 兜底提取（JSON-LD 失败时的降级方案）
  // ══════════════════════════════════════════════════════

  /** 清洗 HTML：去除 script/style 标签，取可见文本 */
  private _cleanHtml(html: string): string {
    return html
      .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, "")
      .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, "")
      .replace(/<[^>]+>/g, " ")
      .replace(/&[a-z]+;/gi, " ")
      .replace(/\s{2,}/g, "\n")
      .trim()
      .substring(0, 3000);
  }

  /** AI 兜底：从无 JSON-LD 的 HTML 中提取食谱 */
  async scrapeFromHtmlWithAI(html: string, agyEngine: AgyEngine, sourceUrl?: string): Promise<ScrapedRecipe | null> {
    const text = this._cleanHtml(html);
    if (text.length < 50) return null;

    const prompt = `从以下网页文本中提取食谱信息。返回严格 JSON（不要用 \`\`\`json 包裹）：
{
  "name": "菜名",
  "ingredients": ["食材1 数量", "食材2 数量"],
  "steps": ["步骤1", "步骤2"],
  "image": "图片URL（如果有）"
}

网页文本：
${text}`;

    try {
      const raw = await agyEngine.executeRaw(prompt);
      if (!raw) return null;
      const cleaned = raw.replace(/```json|```/g, "").trim();
      const parsed = JSON.parse(cleaned);
      if (!parsed.name || !parsed.ingredients) return null;

      const ingStrings: string[] = Array.isArray(parsed.ingredients)
        ? parsed.ingredients.map(String)
        : String(parsed.ingredients).split(/[\n，,、；;]/);
      const ingredients: ParsedIngredient[] = [];
      for (const s of ingStrings) {
        const p = this.converter.parse(s.trim());
        if (p && p.grams > 0) ingredients.push(p);
        else if (p) ingredients.push({ name: s.trim(), grams: 0, originalText: s.trim() });
      }
      const steps: string[] = Array.isArray(parsed.steps)
        ? parsed.steps.map(String).filter((s: string) => s.length > 0)
        : String(parsed.steps || "").split(/[\n，,、；;]/).filter((s: string) => s.length > 0);

      return { name: parsed.name, ingredients, steps, sourceUrl, imageUrl: parsed.image || parsed.imageUrl };
    } catch {
      return null;
    }
  }

  // ══════════════════════════════════════════════════════
  //  v4.2 HTML 增强提取
  // ══════════════════════════════════════════════════════

  /** 从 HTML 中提取小贴士/烹饪技巧 */
  private _extractTipsFromHtml(html: string): string[] {
    const tips: string[] = [];
    // 尝试找到小贴士区块的标题位置
    const tipMatch = html.match(TIPS_SECTION_RE);
    if (!tipMatch || tipMatch.index === undefined) return tips;

    // 从小贴士标题后取 2000 字符搜索 <li> 项
    const tail = html.substring(tipMatch.index, tipMatch.index + 3000);
    let m: RegExpExecArray | null;
    TIPS_LIST_RE.lastIndex = 0;
    while ((m = TIPS_LIST_RE.exec(tail)) !== null) {
      if (m[1]) {
        const text = m[1].replace(/<[^>]+>/g, "").trim();
        if (text.length > 2 && text.length < 200) tips.push(text);
      }
      if (tips.length >= 8) break; // 最多 8 条
    }

    // 回退：尝试段落 <p> 标签
    if (tips.length === 0) {
      const pRe = /<p[^>]*>([\s\S]*?)<\/p>/gi;
      pRe.lastIndex = 0;
      while ((m = pRe.exec(tail)) !== null) {
        if (m[1]) {
          const text = m[1].replace(/<[^>]+>/g, "").trim();
          if (text.length > 5 && text.length < 200) tips.push(text);
        }
        if (tips.length >= 8) break;
      }
    }

    return tips;
  }

  /** 从 HTML 中提取第一张内容图片 URL（通常为成品图） */
  private _extractFirstImageFromHtml(html: string): string | undefined {
    // 优先查找 og:image meta 标签
    const ogMatch = html.match(/<meta[^>]+property="og:image"[^>]+content="([^"]+)"/i)
      || html.match(/<meta[^>]+content="([^"]+)"[^>]+property="og:image"/i);
    if (ogMatch && ogMatch[1]) return ogMatch[1];

    // 回退：第一个 <img> 标签
    const imgMatch = html.match(/<img[^>]+src="([^"]+\.(?:jpg|jpeg|png|webp)[^"]*)"/i);
    if (imgMatch && imgMatch[1]) return imgMatch[1];

    return undefined;
  }
}

// src/nutrition/FoodDatabase.ts
//
// 统一食材数据库引擎 v3.0
// 替代 searchUSDA/searchChinese 中分散的 O(n) filter/find 搜索。
// 启动时构建倒排索引 + 中英映射预计算，运行时 O(1) 精确查找 + O(候选池) 模糊搜索。

import { USDA_FOODS } from "./usda-mini";
import chinaFoodsEmbedded from "./china-foods.json";
import { getFDCFoods, type FDCFoodEntry } from "./fdc-data";

// ── 食物条目（统一内部表示）──────────────────────────
export interface FoodEntry {
  name: string;                          // 原始名称
  nameLower: string;                     // 小写名称（用于匹配）
  nutrients: Record<string, number>;     // 每 100g 的营养素
  source: "china" | "fdc" | "usda";      // 数据来源
}

export interface FoodMatch {
  entry: FoodEntry;
  score: number;                         // 匹配得分（0-250+）
}

// ── 零热量快速拦截词条（来自 searchUSDA fast track）──
const ZERO_CALORIE_KEYWORDS = new Set([
  "water", "水", "清水", "饮用水", "开水", "白开水", "冷水", "热水", "温水", "蒸锅用水",
  "高汤", "清汤", "骨汤", "冰", "冰块", "葱姜水", "葱姜蒜",
  "salt", "食盐", "盐", "食用盐", "料酒", "黄酒", "cooking wine",
  "蘸料碟", "其他调料", "香叶", "八角", "桂皮", "月桂叶", "丁香", "茴香",
  "干辣椒", "花椒", "青花椒", "花椒油", "藤椒油", "芥末油",
  "辣椒粉", "五香粉", "十三香", "白胡椒粉", "黑胡椒粉", "黑胡椒",
  "孜然粉", "孜然籽", "小苏打", "干酵母", "泡打粉",
  "葱结", "姜片", "蒜瓣", "蒜末", "蒜粉", "姜末", "葱花", "香菜叶",
]);

// ── 中文→英文映射表（从 menu-calculator.ts 提取，构建时预计算）──
// 注：此表由 menu-calculator.ts 的 FOOD_CN_MAP 复制而来，保持同步
import { FOOD_CN_MAP } from "./food-cn-map";

// ── 每个食材的平均重量（克）──
const AVG_WEIGHT_GRAMS: Record<string, number> = {
  "鸡蛋": 50, "鸭蛋": 70, "鹌鹑蛋": 10,
  "苹果": 200, "香蕉": 120, "橙子": 180, "柠檬": 80,
  "土豆": 150, "红薯": 200, "洋葱": 150,
  "番茄": 150, "西红柿": 150, "黄瓜": 200,
  "大蒜": 5, "蒜瓣": 5, "姜": 15,
};

export class FoodDatabase {
  // 主索引
  private nameIndex: Map<string, FoodEntry> = new Map();
  // 关键词倒排索引: keyword → Set<entry_name_lower>
  private keywordIndex: Map<string, Set<string>> = new Map();
  // 预计算的中文→英文→FoodEntry 缓存
  private cnCache: Map<string, FoodEntry | null> = new Map();
  // 所有条目
  private allFoods: FoodEntry[] = [];

  private built = false;

  constructor() {}

  // ══════════════════════════════════════════════════════
  //  构建索引（启动时调用一次）
  // ══════════════════════════════════════════════════════

  build(fdcFoods?: FDCFoodEntry[]): this {
    if (this.built) return this;
    this.allFoods = [];

    // 1. 加载中国食物成分表 (1725 条)
    for (const [name, rawNutrients] of chinaFoodsEmbedded as unknown as FDCFoodEntry[]) {
      // 过滤 undefined 值（某些营养素在特定食物中未定义）
      const nutrients: Record<string, number> = {};
      for (const [k, v] of Object.entries(rawNutrients)) {
        if (typeof v === "number") nutrients[k] = v;
      }
      this._addEntry({ name, nameLower: name.toLowerCase(), nutrients, source: "china" });
    }

    // 2. 加载 FDC 数据 (8064 条，如果可用)
    const fdc = fdcFoods || getFDCFoods();
    for (const [name, rawNutrients] of fdc) {
      const nutrients: Record<string, number> = {};
      for (const [k, v] of Object.entries(rawNutrients)) {
        if (typeof v === "number") nutrients[k] = v;
      }
      this._addEntry({ name, nameLower: name.toLowerCase(), nutrients, source: "fdc" });
    }

    // 3. 加载 USDA 迷你数据 (200 条)
    for (const entry of USDA_FOODS) {
      const nutrients: Record<string, number> = {};
      for (const [k, v] of Object.entries(entry.d as Record<string, number>)) {
        if (typeof v === "number") nutrients[k] = v;
      }
      this._addEntry({
        name: entry.n,
        nameLower: entry.n.toLowerCase(),
        nutrients,
        source: "usda",
      });
    }

    // 4. 预计算中文映射缓存：每个中文名 → 直接匹配的 FoodEntry
    for (const cnName of Object.keys(FOOD_CN_MAP)) {
      const enName = FOOD_CN_MAP[cnName];
      if (!enName) continue;
      const entry = this.nameIndex.get(enName.toLowerCase()) ?? null;
      this.cnCache.set(cnName, entry);
    }

    this.built = true;
    return this;
  }

  private _addEntry(entry: FoodEntry): void {
    this.allFoods.push(entry);
    this.nameIndex.set(entry.nameLower, entry);

    // 构建倒排索引：对食物名的每个关键词（≥2 字符）建索引
    const tokens = entry.nameLower.split(/[,\s\(\)\/]+/).filter(t => t.length >= 2);
    const seenTokens = new Set<string>();
    for (const token of tokens) {
      if (seenTokens.has(token)) continue;
      seenTokens.add(token);
      if (!this.keywordIndex.has(token)) {
        this.keywordIndex.set(token, new Set());
      }
      this.keywordIndex.get(token)!.add(entry.nameLower);
    }
  }

  // ══════════════════════════════════════════════════════
  //  公共查询 API
  // ══════════════════════════════════════════════════════

  /** 设置用户自定义食材别名（优先级高于 FOOD_CN_MAP） */
  private userAliases: Map<string, string> = new Map();

  setUserAliases(aliases: Record<string, string>): void {
    this.userAliases.clear();
    for (const [k, v] of Object.entries(aliases)) {
      if (k && v) this.userAliases.set(k, v);
    }
    // 清除受影响的缓存条目
    for (const k of Object.keys(aliases)) {
      this.cnCache.delete(k);
    }
  }

  /** 查询中文食材名 → 最佳匹配的 FoodEntry */
  lookupChinese(cnName: string): FoodEntry | null {
    // 0. 用户自定义别名优先
    const userAlias = this.userAliases.get(cnName);
    if (userAlias) {
      // 先尝试作为中文名直接搜
      const direct = this.nameIndex.get(userAlias.toLowerCase());
      if (direct) return direct;
      // 再尝试作为英文名搜
      const enMatch = this.lookupEnglish(userAlias);
      if (enMatch) return enMatch;
    }
    // 0. 零热量快速拦截
    if (ZERO_CALORIE_KEYWORDS.has(cnName)) {
      return { name: cnName, nameLower: cnName.toLowerCase(), nutrients: { Energy: 0 }, source: "china" };
    }

    // 1. 直接用中文名搜（china-foods.json 中文条目）
    const directCn = this.nameIndex.get(cnName.toLowerCase());
    if (directCn) return directCn;

    // 2. 预计算缓存：CN → EN → Entry
    const cnKey = FOOD_CN_MAP[cnName];
    if (cnKey) {
      const cached = this.cnCache.get(cnName);
      if (cached) return cached;
      // 缓存未命中 → 用英文名搜（回退）
      const enMatch = this.lookupEnglish(cnKey);
      if (enMatch) {
        this.cnCache.set(cnName, enMatch);
        return enMatch;
      }
    }

    // 3. 部分匹配：最长键优先
    const partialKeys = Object.keys(FOOD_CN_MAP)
      .filter(k => k.length >= 1 && cnName.includes(k))
      .sort((a, b) => b.length - a.length);
    for (const key of partialKeys) {
      const cached = this.cnCache.get(key);
      if (cached) return cached;
      const enVal = FOOD_CN_MAP[key];
      if (enVal) {
        const match = this.lookupEnglish(enVal);
        if (match) {
          this.cnCache.set(key, match);
          return match;
        }
      }
    }

    // 4. 字符级兜底：逐级短子串直接搜中文数据库
    if (cnName.length >= 2) {
      for (let len = cnName.length - 1; len >= 2; len--) {
        for (let start = 0; start <= cnName.length - len; start++) {
          const sub = cnName.substring(start, start + len);
          const entry = this.nameIndex.get(sub.toLowerCase());
          if (entry) return entry;
        }
      }
    }

    return null;
  }

  /** 查询英文食材名 → 最佳匹配的 FoodEntry（打分引擎） */
  lookupEnglish(enName: string): FoodEntry | null {
    const kw = enName.toLowerCase().trim();
    if (!kw) return null;

    // 0. 零热量快速拦截
    if (ZERO_CALORIE_KEYWORDS.has(kw)) {
      return { name: kw, nameLower: kw, nutrients: { Energy: 0 }, source: "china" };
    }

    // 1. O(1) 精确命中
    const exact = this.nameIndex.get(kw);
    if (exact) return exact;

    // 2. 关键词交集候选池
    const kwTokens = kw.split(/[\s,]+/).filter(t => t.length >= 2);
    const candidates = this._getCandidates(kwTokens);
    if (candidates.length === 0) return null;

    // 3. 打分引擎（复用现有 6 维度加权）
    return this._scoreAndPick(kw, kwTokens, candidates);
  }

  /** 获取食材的营养数据（每 100g） */
  getNutrition(entry: FoodEntry, amountGrams: number): Record<string, number> {
    const ratio = amountGrams / 100;
    const result: Record<string, number> = {};
    for (const [k, v] of Object.entries(entry.nutrients)) {
      result[k] = v * ratio;
    }
    return result;
  }

  /** 按名称精确查找（O(1)） */
  getByName(name: string): FoodEntry | null {
    return this.nameIndex.get(name.toLowerCase()) ?? null;
  }

  /** 获取食材的平均单个重量（克） */
  getAvgWeight(name: string): number {
    return AVG_WEIGHT_GRAMS[name] ?? AVG_WEIGHT_GRAMS[name.toLowerCase()] ?? 50;
  }

  // ══════════════════════════════════════════════════════
  //  内部方法
  // ══════════════════════════════════════════════════════

  /** 关键词交集：取每个 token 的候选集合的交集 */
  private _getCandidates(tokens: string[]): FoodEntry[] {
    if (tokens.length === 0) return [];

    // 取第一个 token 的候选集
    const firstSet = this.keywordIndex.get(tokens[0]!);
    if (!firstSet || firstSet.size === 0) return [];

    // 与后续 token 的候选集取交集
    let resultNames = firstSet;
    for (let i = 1; i < tokens.length; i++) {
      const tokenSet = this.keywordIndex.get(tokens[i]!);
      if (!tokenSet) return [];
      // 取交集（小集合优化：遍历较小的集合）
      const intersection = new Set<string>();
      const [smaller, larger] = resultNames.size <= tokenSet.size
        ? [resultNames, tokenSet] : [tokenSet, resultNames];
      for (const name of smaller) {
        if (larger.has(name)) intersection.add(name);
      }
      resultNames = intersection;
      if (resultNames.size === 0) return [];
    }

    // 转为 FoodEntry 数组
    const result: FoodEntry[] = [];
    for (const name of resultNames) {
      const entry = this.nameIndex.get(name);
      if (entry) result.push(entry);
    }
    return result;
  }

  /** 6 维度加权打分（从 searchUSDA 迁移） */
  private _scoreAndPick(kw: string, kwTokens: string[], candidates: FoodEntry[]): FoodEntry | null {
    const isMultiWord = kwTokens.length > 1;
    let bestMatch: FoodEntry | null = null;
    let bestScore = 0;

    for (const food of candidates) {
      const nameLower = food.nameLower;
      let score = 0;

      // 词边界匹配 (+100 单 / +120 多)
      if (isMultiWord) {
        const allBoundaries = kwTokens.every(w => this._tokenMatch(nameLower, w));
        if (allBoundaries) score += 120;
      } else {
        if (this._tokenMatch(nameLower, kw)) score += 100;
      }

      // 主类别首段匹配 (+50)
      const firstSegment = (nameLower.split(",")[0] || "").trim();
      if (firstSegment === kw || this._tokenMatch(firstSegment, kw)) score += 50;

      // 中国数据源 (+30)
      if (food.source === "china") score += 30;

      // 前缀匹配 (+20)
      if (nameLower.startsWith(kw)) score += 20;

      // 包含兜底 (+10)
      score += 10;

      // 共词相似度 (0-40)
      score += this._calculateSimilarity(kw, nameLower) * 40;

      if (score > bestScore) {
        bestScore = score;
        bestMatch = food;
      }
    }

    return bestScore >= 40 ? bestMatch : null;
  }

  /** 词边界 token 匹配 */
  private _tokenMatch(foodName: string, keyword: string): boolean {
    const tokens = foodName.split(/[,\s\(\)\/]+/);
    return tokens.some(t => t === keyword);
  }

  /** 共词相似度打分 */
  private _calculateSimilarity(query: string, target: string): number {
    const queryWords = new Set(query.split(/[\s,]+/).filter(w => w.length > 1));
    const targetWords = target.split(/[\s,]+/).filter(w => w.length > 1);
    if (queryWords.size === 0) return 0;
    let matches = 0;
    for (const tw of targetWords) {
      for (const qw of queryWords) {
        if (tw === qw || (qw.length >= 3 && tw.startsWith(qw)) || (tw.length >= 3 && qw.startsWith(tw))) {
          matches++;
          break;
        }
      }
    }
    return matches / queryWords.size;
  }

  /** 索引统计（调试用） */
  stats(): { totalFoods: number; nameIndexSize: number; keywordIndexSize: number; cnCacheSize: number } {
    return {
      totalFoods: this.allFoods.length,
      nameIndexSize: this.nameIndex.size,
      keywordIndexSize: this.keywordIndex.size,
      cnCacheSize: this.cnCache.size,
    };
  }
}

/** 全局单例 */
let _instance: FoodDatabase | null = null;

export function getFoodDatabase(): FoodDatabase {
  if (!_instance) {
    _instance = new FoodDatabase().build();
  }
  return _instance;
}

export function rebuildFoodDatabase(fdcFoods?: FDCFoodEntry[]): FoodDatabase {
  _instance = new FoodDatabase().build(fdcFoods);
  return _instance;
}

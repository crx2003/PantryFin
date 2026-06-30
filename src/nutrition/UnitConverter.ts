// src/nutrition/UnitConverter.ts
//
// 中英文多单位食材解析器 v3.1
// 借鉴 Tandoor Recipes 的 IngredientParser 设计：
//   - Unicode 分数支持 (¼½¾⅛ 等)
//   - 备注自动提取 (逗号/括号/中文烹饪术语)
//   - 中文特有模式 (半斤/一两/一勺/适量/根据口味)
//   - 范围量词处理 (2-3个)

// ── Unicode 分数映射 ──────────────────────────────────
const UNICODE_FRACTIONS: Record<string, number> = {
  "½": 0.5, "⅓": 1/3, "⅔": 2/3, "¼": 0.25, "¾": 0.75,
  "⅕": 0.2, "⅖": 0.4, "⅗": 0.6, "⅘": 0.8,
  "⅙": 1/6, "⅚": 5/6, "⅛": 0.125, "⅜": 0.375, "⅝": 0.625, "⅞": 0.875,
  "↉": 0,
};

// ── 中文数量词 ───────────────────────────────────────
const CN_NUMBERS: Record<string, number> = {
  "半": 0.5, "一": 1, "二": 2, "两": 2, "三": 3, "四": 4,
  "五": 5, "六": 6, "七": 7, "八": 8, "九": 9, "十": 10,
};

// ── 单位定义 ─────────────────────────────────────────
interface UnitDef {
  category: "weight" | "volume" | "count";
  toGrams: number | null;
  aliases: string[];
}

const UNIT_TABLE: UnitDef[] = [
  // 重量 → 克
  { category: "weight", toGrams: 1,      aliases: ["g", "克", "gram", "grams", "公克"] },
  { category: "weight", toGrams: 500,    aliases: ["斤", "市斤", "jin", "catty"] },
  { category: "weight", toGrams: 50,     aliases: ["两", "tael"] },
  { category: "weight", toGrams: 1000,   aliases: ["kg", "KG", "Kg", "千克", "公斤", "kilogram"] },
  { category: "weight", toGrams: 0.001,  aliases: ["mg", "毫克", "milligram"] },
  // 体积 → 毫升 (近似克)
  { category: "volume", toGrams: 1,      aliases: ["ml", "ML", "毫升", "milliliter", "cc"] },
  { category: "volume", toGrams: 1000,   aliases: ["l", "L", "升", "liter", "公升"] },
  { category: "volume", toGrams: 15,     aliases: ["汤匙", "大匙", "tablespoon", "tbsp", "大勺", "一勺"] },
  { category: "volume", toGrams: 5,      aliases: ["茶匙", "小匙", "teaspoon", "tsp", "小勺"] },
  { category: "volume", toGrams: 3,      aliases: ["少许", "适量", "酌情"] },
  { category: "volume", toGrams: 1,      aliases: ["滴", "几滴"] },
  { category: "volume", toGrams: 240,    aliases: ["杯", "cup", "cups", "玻璃杯"] },
  // 计数 → 需查食材平均重量表
  { category: "count",  toGrams: null,   aliases: ["个", "枚", "只", "根", "条", "颗", "粒", "片", "块", "瓣", "节", "段"] },
];

// ── 食材平均重量 (克/个) ──────────────────────────────
const AVG_WEIGHT: Record<string, number> = {
  "鸡蛋": 50, "鸭蛋": 70, "鹌鹑蛋": 10, "皮蛋": 60,
  "苹果": 200, "香蕉": 120, "橙子": 180, "柠檬": 80,
  "土豆": 150, "红薯": 200, "洋葱": 150, "番茄": 150,
  "西红柿": 150, "黄瓜": 200, "茄子": 250, "青椒": 80,
  "大蒜": 30, "蒜头": 30, "姜": 100, "大葱": 50,
  "小葱": 5, "香菜": 3, "干辣椒": 2,
  "鸡蛋清": 33, "鸡蛋黄": 17, "鸡蛋🥚": 50,
  "蒜瓣": 5, "生姜": 100,
};

// ── 烹饪备注关键词（需从食材名中剥离） ────────────────
const COOKING_NOTES_CN = [
  "根据口味增减", "根据口味加减", "根据个人口味", "依个人口味",
  "约", "左右", "适量", "少许", "酌情",
  "或", "或者", "也可", "可选",
  "去皮", "切块", "切段", "切片", "切丝", "切末", "切碎",
  "剁碎", "拍碎", "压碎", "碾碎", "捣碎",
  "洗净", "沥干", "泡发", "提前泡", "提前解冻",
  "焯水", "汆烫", "过水", "飞水",
  "腌制", "略腌", "抓匀",
];

export interface ParsedIngredient {
  name: string;
  grams: number;
  originalText: string;
  unit?: string;
  note?: string;
}

export class UnitConverter {
  /**
   * 解析单行食材文本 → 结构化数据。
   * 借鉴 Tandoor IngredientParser：分数→浮点 + 备注提取 + 括号处理。
   */
  parse(text: string): ParsedIngredient | null {
    const original = text.trim();
    if (!original) return null;

    let working = original;
    const notes: string[] = [];

    // ── Step 1: 提取括号内备注 ──
    // 例: "五花肉 300g (根据口味增减)" → note="根据口味增减"
    const parenMatch = working.match(/[(（]\s*([^)）]+)\s*[)）]/);
    if (parenMatch) {
      notes.push(parenMatch[1]!.trim());
      working = working.replace(/[(（]\s*[^)）]+\s*[)）]/, "").trim();
    }

    // ── Step 2: 提取逗号/中文逗号后的烹饪备注 ──
    // 例: "五花肉 300g，切块" → note="切块"
    const commaIdx = Math.max(
      working.lastIndexOf(","),
      working.lastIndexOf("，"),
    );
    if (commaIdx > 0) {
      const afterComma = working.substring(commaIdx + 1).trim();
      // 判断是否为备注（含烹饪动词/量词）而非食材名的一部分
      const isNote = COOKING_NOTES_CN.some(kw => afterComma.includes(kw))
        || /^[\d约可或]/.test(afterComma)
        || afterComma.length <= 4;
      if (isNote) {
        notes.push(afterComma);
        working = working.substring(0, commaIdx).trim();
      }
    }

    // ── Step 3: Unicode 分数 → 浮点 ──
    // 例: "2¼" → "2.25", "½ cup" → "0.5 cup"
    for (const [frac, val] of Object.entries(UNICODE_FRACTIONS)) {
      if (!working.includes(frac)) continue;
      // 数字紧邻分数: "2¼" → 2 + 0.25 → "2.25"
      working = working.replace(new RegExp(`(\\d+)\\s*${frac}`, "gu"),
        (_, digit) => String(parseFloat(digit) + val));
      // 单独分数: "¼ cup" → "0.25 cup"
      working = working.replace(new RegExp(frac, "gu"), String(val));
    }

    // ── Step 4: "数字+空格+数字/数字" 分数 → 浮点 ──
    // 例: "4 1/2 Zwiebeln" → "4.5 Zwiebeln"
    working = working.replace(/(\d+)\s+(\d+)\/(\d+)/g, (_, w, n, d) =>
      String(parseInt(w) + parseInt(n) / parseInt(d))
    );

    // ── Step 5: 斜杠分数 → 浮点 ──
    // 例: "1/2杯 牛奶" → "0.5杯 牛奶"
    working = working.replace(/(\d+)\/(\d+)/g, (_, n, d) =>
      String(parseInt(n) / parseInt(d))
    );

    // ── Step 6: "约" "左右" 剥离为备注 ──
    working = working.replace(/[约大约]\s*/g, "");
    working = working.replace(/\s*左右/g, "");
    if (/[约大约]/.test(original)) notes.push("约");

    // ── Step 6b: "数字 单位 食材名" 模式 ──
    // 例: "0.5 杯 牛奶" → amount=0.5, unit=杯, food=牛奶
    for (const unitDef of UNIT_TABLE) {
      for (const alias of unitDef.aliases) {
        const escaped = alias.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const m = working.match(new RegExp(`^(\\d+(?:\\.\\d+)?)\\s*${escaped}\\s+(.+)$`, "i"));
        if (m) {
          const amount = parseFloat(m[1]!);
          const name = m[2]!.trim();
          if (!isNaN(amount) && name.length > 0) {
            return this._toGrams(name, amount, alias, original, notes);
          }
        }
      }
    }

    // ── Step 7: 中文数量词+单位前置模式 ──
    // 例: "半斤五花肉" → 数量=0.5, 单位=斤, 食材=五花肉
    // 数量词后必须紧跟有效单位（可无空格），避免 "五花肉" 的 "五" 被误识别
    const cnPreMatch = working.match(
      /^([半一二两三四五六七八九十\d.]+)\s*(斤|两|千克|公斤|kg|KG|g|克|ml|毫升|l|L|升|个|枚|只|根|条|颗|汤匙|茶匙|大匙|小匙|大勺|小勺|滴|几滴|少许|适量)\s*(.+)$/i
    );
    if (cnPreMatch) {
      const numStr = cnPreMatch[1]!;
      const unitStr = cnPreMatch[2] || undefined;
      const name = cnPreMatch[3]!.trim();
      const num = CN_NUMBERS[numStr] ?? parseFloat(numStr);
      if (!isNaN(num) && name.length > 0) {
        return this._toGrams(name, num, unitStr, original, notes);
      }
    }

    // ── Step 8: 标准 "食材名 数字 单位" 模式 ──
    // (.+?) 改为贪婪 (.+?) 但在数字前截断：匹配到最后一个非数字字符
    const stdMatch = working.match(/^(.+?)\s+(\d+(?:\.\d+)?)\s*([a-zA-Z一-鿿]+)?$/);
    if (stdMatch) {
      const name = stdMatch[1]!.trim();
      const amount = parseFloat(stdMatch[2]!);
      const unitStr = stdMatch[3]?.trim();
      return this._toGrams(name, amount, unitStr, original, notes);
    }

    // ── Step 9: "食材名 数字" (无单位，默认克) ──
    const numMatch = working.match(/^(.+?)\s+(\d+(?:\.\d+)?)$/);
    if (numMatch) {
      return {
        name: numMatch[1]!.trim(),
        grams: parseFloat(numMatch[2]!),
        originalText: original,
        unit: "g",
        note: notes.length > 0 ? notes.join("; ") : undefined,
      };
    }

    // ── Step 9b: "食材名 少许/适量/酌情" (模糊量词) ──
    const vagueMatch = working.match(/^(.+?)\s+(少许|适量|酌情|几滴)$/);
    if (vagueMatch) {
      const unitDef = UNIT_TABLE.find(u => u.aliases.includes(vagueMatch[2]!));
      return {
        name: this._cleanName(vagueMatch[1]!.trim()),
        grams: unitDef?.toGrams ?? 3,
        originalText: original,
        unit: vagueMatch[2],
        note: notes.length > 0 ? notes.join("; ") : vagueMatch[2],
      };
    }

    // ── Step 10: 无法解析 → 返回原始文本 ──
    return {
      name: working,
      grams: 0,
      originalText: original,
      note: notes.length > 0 ? notes.join("; ") : undefined,
    };
  }

  parseLines(text: string): ParsedIngredient[] {
    return text.split("\n")
      .map(line => this.parse(line))
      .filter((p): p is ParsedIngredient => p !== null);
  }

  private _toGrams(
    name: string, amount: number, unitStr: string | undefined,
    original: string, notes: string[]
  ): ParsedIngredient {
    const unitDef = unitStr
      ? UNIT_TABLE.find(u => u.aliases.some(a => a.toLowerCase() === unitStr.toLowerCase()))
      : undefined;

    if (unitDef) {
      if (unitDef.toGrams !== null) {
        return {
          name: this._cleanName(name),
          grams: Math.round(amount * unitDef.toGrams),
          originalText: original,
          unit: unitDef.aliases[0],
          note: notes.length > 0 ? notes.join("; ") : undefined,
        };
      }
      // 计数单位 → 查平均重量
      const avgGrams = AVG_WEIGHT[name] ?? AVG_WEIGHT[this._cleanName(name)] ?? 50;
      return {
        name: this._cleanName(name),
        grams: Math.round(amount * avgGrams),
        originalText: original,
        unit: unitDef.aliases[0],
        note: notes.length > 0 ? notes.join("; ") : undefined,
      };
    }

    return {
      name: this._cleanName(name),
      grams: Math.round(amount),
      originalText: original,
      unit: unitStr || "g",
      note: notes.length > 0 ? notes.join("; ") : undefined,
    };
  }

  private _cleanName(name: string): string {
    return name
      .replace(/[🥚🍚🍳🍰🧂🥩🥬🥣🐟🥤🍪🌽🥕🧄🧅🫑🥒🥦🍄]/gu, "")
      .replace(/\s+/g, "")
      .trim();
  }
}

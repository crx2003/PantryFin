// 菜单营养计算模块
import { USDA_FOODS } from './usda-mini';
import { FoodDataLoader, USDAFood } from './fooddata-loader';
import { getFoodDatabase } from './FoodDatabase';

export interface MenuIngredient {
    name: string;
    amount: number;
    matched?: string;
    source?: 'usda' | 'boohee' | 'fooddata' | 'china';
    nutrients?: Record<string, number>;
}

export interface NutritionResult {
    [key: string]: number;
}

interface BooheeNutrientItem {
    name: string;
    name_en?: string;
    value: number;
    unit_name: string;
    items?: BooheeNutrientItem[];
}

interface BooheeFoodDetail {
    food: { name: string; code: string };
    calory?: BooheeNutrientItem[];
    base_ingredients?: BooheeNutrientItem[];
    vitamin?: BooheeNutrientItem[];
    mineral?: BooheeNutrientItem[];
    amino_acid?: BooheeNutrientItem[];
    other_ingredients?: BooheeNutrientItem[];
}

interface BooheeSearchResponse {
    foods?: { code: string; name: string }[];
}

interface BooheeClient {
    searchFood(keyword: string): Promise<BooheeSearchResponse>;
    getFoodDetail(code: string): Promise<BooheeFoodDetail>;
}

interface CalcOptions {
    loader?: FoodDataLoader;
    boohee?: BooheeClient;
}

// ============== 中文食材映射 ==============
import { FOOD_CN_MAP } from "./food-cn-map";


// ============== DRIs ==============
export const DRIs: Record<string, Record<string, number>> = {
    '成年男性': {
        'Energy': 2250,
        'Protein': 65,
        'Total lipid (fat)': 75,
        'Carbohydrate, by difference': 300,
        'Fiber, total dietary': 25,
        'Cholesterol': 300,
        'Vitamin A, RAE': 800,
        'Vitamin D (D2 + D3)': 10,
        'Vitamin E (alpha-tocopherol)': 14,
        'Vitamin K (phylloquinone)': 80,
        'Thiamin': 1.4,
        'Riboflavin': 1.4,
        'Vitamin B-6': 1.4,
        'Vitamin B-12': 2.4,
        'Vitamin C, total ascorbic acid': 100,
        'Pantothenic acid': 5,
        'Folate, total': 400,
        'Niacin': 15,
        'Biotin': 40,
        'Calcium, Ca': 800,
        'Phosphorus, P': 720,
        'Potassium, K': 2000,
        'Sodium, Na': 1500,
        'Magnesium, Mg': 330,
        'Chloride, Cl': 2300,
        'Iron, Fe': 12,
        'Iodine, I': 120,
        'Zinc, Zn': 12.5,
        'Selenium, Se': 60,
        'Copper, Cu': 0.8,
        'Manganese, Mn': 4.5,
        'Choline, total': 500,
    },
    '成年女性': {
        'Energy': 1800,
        'Protein': 55,
        'Total lipid (fat)': 60,
        'Carbohydrate, by difference': 250,
        'Fiber, total dietary': 25,
        'Cholesterol': 300,
        'Vitamin A, RAE': 700,
        'Vitamin D (D2 + D3)': 10,
        'Vitamin E (alpha-tocopherol)': 14,
        'Vitamin K (phylloquinone)': 80,
        'Thiamin': 1.2,
        'Riboflavin': 1.2,
        'Vitamin B-6': 1.2,
        'Vitamin B-12': 2.4,
        'Vitamin C, total ascorbic acid': 100,
        'Pantothenic acid': 5,
        'Folate, total': 400,
        'Niacin': 12,
        'Biotin': 40,
        'Calcium, Ca': 800,
        'Phosphorus, P': 720,
        'Potassium, K': 2000,
        'Sodium, Na': 1500,
        'Magnesium, Mg': 280,
        'Chloride, Cl': 2300,
        'Iron, Fe': 20,
        'Iodine, I': 120,
        'Zinc, Zn': 7.5,
        'Selenium, Se': 60,
        'Copper, Cu': 0.8,
        'Manganese, Mn': 4.5,
        'Choline, total': 400,
    },
    '孕妇': {
        'Energy': 2100,
        'Protein': 70,
        'Total lipid (fat)': 70,
        'Carbohydrate, by difference': 275,
        'Fiber, total dietary': 25,
        'Cholesterol': 300,
        'Vitamin A, RAE': 770,
        'Vitamin D (D2 + D3)': 10,
        'Vitamin E (alpha-tocopherol)': 14,
        'Vitamin K (phylloquinone)': 80,
        'Thiamin': 1.5,
        'Riboflavin': 1.5,
        'Vitamin B-6': 1.9,
        'Vitamin B-12': 2.6,
        'Vitamin C, total ascorbic acid': 115,
        'Pantothenic acid': 6,
        'Folate, total': 600,
        'Niacin': 15,
        'Biotin': 40,
        'Calcium, Ca': 1000,
        'Phosphorus, P': 720,
        'Potassium, K': 2500,
        'Sodium, Na': 1500,
        'Magnesium, Mg': 370,
        'Chloride, Cl': 2300,
        'Iron, Fe': 29,
        'Iodine, I': 230,
        'Zinc, Zn': 9.5,
        'Selenium, Se': 65,
        'Copper, Cu': 0.9,
        'Manganese, Mn': 4.5,
        'Choline, total': 450,
    },
    '老年人(65+)': {
        'Energy': 1900,
        'Protein': 65,
        'Total lipid (fat)': 60,
        'Carbohydrate, by difference': 250,
        'Fiber, total dietary': 25,
        'Cholesterol': 300,
        'Vitamin A, RAE': 800,
        'Vitamin D (D2 + D3)': 15,
        'Vitamin E (alpha-tocopherol)': 14,
        'Vitamin K (phylloquinone)': 80,
        'Thiamin': 1.3,
        'Riboflavin': 1.3,
        'Vitamin B-6': 1.5,
        'Vitamin B-12': 2.4,
        'Vitamin C, total ascorbic acid': 100,
        'Pantothenic acid': 5,
        'Folate, total': 400,
        'Niacin': 13,
        'Biotin': 40,
        'Calcium, Ca': 1000,
        'Phosphorus, P': 720,
        'Potassium, K': 2000,
        'Sodium, Na': 1400,
        'Magnesium, Mg': 320,
        'Chloride, Cl': 2300,
        'Iron, Fe': 12,
        'Iodine, I': 120,
        'Zinc, Zn': 10,
        'Selenium, Se': 60,
        'Copper, Cu': 0.8,
        'Manganese, Mn': 4.5,
        'Choline, total': 450,
    },
};

// ============== 营养素单位 ==============
const UNITS: Record<string, string> = {
    'Energy': 'kcal', 'Protein': 'g', 'Total lipid (fat)': 'g',
    'Carbohydrate, by difference': 'g', 'Fiber, total dietary': 'g',
    'Cholesterol': 'mg', 'Vitamin A, RAE': 'μg', 'Vitamin D (D2 + D3)': 'μg',
    'Vitamin E (alpha-tocopherol)': 'mg', 'Vitamin K (phylloquinone)': 'μg',
    'Thiamin': 'mg', 'Riboflavin': 'mg', 'Vitamin B-6': 'mg', 'Vitamin B-12': 'μg',
    'Vitamin C, total ascorbic acid': 'mg', 'Pantothenic acid': 'mg',
    'Folate, total': 'μg', 'Niacin': 'mg', 'Calcium, Ca': 'mg', 'Phosphorus, P': 'mg',
    'Potassium, K': 'mg', 'Sodium, Na': 'mg', 'Magnesium, Mg': 'mg', 'Iron, Fe': 'mg',
    'Zinc, Zn': 'mg', 'Selenium, Se': 'μg', 'Copper, Cu': 'mg', 'Manganese, Mn': 'mg',
    'Chloride, Cl': 'mg', 'Iodine, I': 'μg', 'Choline, total': 'mg', 'Biotin': 'μg'
};

const NUTRIENT_CN_NAMES: Record<string, string> = {
    'Energy': '能量',
    'Protein': '蛋白质',
    'Total lipid (fat)': '脂肪',
    'Carbohydrate, by difference': '碳水化合物',
    'Fiber, total dietary': '膳食纤维',
    'Cholesterol': '胆固醇',
    'Vitamin A, RAE': '维生素A',
    'Vitamin D (D2 + D3)': '维生素D',
    'Vitamin E (alpha-tocopherol)': '维生素E',
    'Vitamin K (phylloquinone)': '维生素K',
    'Thiamin': '维生素B1',
    'Riboflavin': '维生素B2',
    'Vitamin B-6': '维生素B6',
    'Vitamin B-12': '维生素B12',
    'Vitamin C, total ascorbic acid': '维生素C',
    'Pantothenic acid': '泛酸',
    'Folate, total': '叶酸',
    'Niacin': '烟酸',
    'Calcium, Ca': '钙',
    'Phosphorus, P': '磷',
    'Potassium, K': '钾',
    'Sodium, Na': '钠',
    'Magnesium, Mg': '镁',
    'Chloride, Cl': '氯',
    'Iron, Fe': '铁',
    'Iodine, I': '碘',
    'Zinc, Zn': '锌',
    'Selenium, Se': '硒',
    'Copper, Cu': '铜',
    'Manganese, Mn': '锰',
    'Choline, total': '胆碱',
    'Biotin': '生物素',
};

function formatNutrientLabel(name: string): string {
    const cn = NUTRIENT_CN_NAMES[name];
    return cn ? `${cn} / ${name}` : name;
}

// ============== 菜单计算器类 ==============
export class MenuCalculator {
    private fallbackFoods: USDAFood[] = USDA_FOODS as USDAFood[];
    private lastBooheeError: string | null = null;
    private booheeAlias: Record<string, string> = {
        '能量': 'Energy',
        '热量': 'Energy',
        'energy': 'Energy',
        'calories': 'Energy',
        '蛋白质': 'Protein',
        'protein': 'Protein',
        '脂肪': 'Total lipid (fat)',
        'fat': 'Total lipid (fat)',
        'total fat': 'Total lipid (fat)',
        '碳水化合物': 'Carbohydrate, by difference',
        'carbohydrate': 'Carbohydrate, by difference',
        'carbs': 'Carbohydrate, by difference',
        '膳食纤维': 'Fiber, total dietary',
        '纤维': 'Fiber, total dietary',
        'fiber': 'Fiber, total dietary',
        '胆固醇': 'Cholesterol',
        'cholesterol': 'Cholesterol',
        '维生素a': 'Vitamin A, RAE',
        'vitamin a': 'Vitamin A, RAE',
        '维生素d': 'Vitamin D (D2 + D3)',
        'vitamin d': 'Vitamin D (D2 + D3)',
        '维生素e': 'Vitamin E (alpha-tocopherol)',
        'vitamin e': 'Vitamin E (alpha-tocopherol)',
        '维生素k': 'Vitamin K (phylloquinone)',
        'vitamin k': 'Vitamin K (phylloquinone)',
        '维生素b1': 'Thiamin',
        '硫胺素': 'Thiamin',
        'thiamin': 'Thiamin',
        '维生素b2': 'Riboflavin',
        '核黄素': 'Riboflavin',
        'riboflavin': 'Riboflavin',
        '维生素b6': 'Vitamin B-6',
        'vitamin b6': 'Vitamin B-6',
        '维生素b12': 'Vitamin B-12',
        'vitamin b12': 'Vitamin B-12',
        '维生素c': 'Vitamin C, total ascorbic acid',
        'vitamin c': 'Vitamin C, total ascorbic acid',
        '泛酸': 'Pantothenic acid',
        'pantothenic acid': 'Pantothenic acid',
        '叶酸': 'Folate, total',
        'folate': 'Folate, total',
        '尼克酸': 'Niacin',
        '烟酸': 'Niacin',
        'niacin': 'Niacin',
        '生物素': 'Biotin',
        'biotin': 'Biotin',
        '钙': 'Calcium, Ca',
        'calcium': 'Calcium, Ca',
        '磷': 'Phosphorus, P',
        'phosphorus': 'Phosphorus, P',
        '钾': 'Potassium, K',
        'potassium': 'Potassium, K',
        '钠': 'Sodium, Na',
        'sodium': 'Sodium, Na',
        '镁': 'Magnesium, Mg',
        'magnesium': 'Magnesium, Mg',
        '铁': 'Iron, Fe',
        'iron': 'Iron, Fe',
        '锌': 'Zinc, Zn',
        'zinc': 'Zinc, Zn',
        '硒': 'Selenium, Se',
        'selenium': 'Selenium, Se',
        '铜': 'Copper, Cu',
        'copper': 'Copper, Cu',
        '锰': 'Manganese, Mn',
        'manganese': 'Manganese, Mn',
        '胆碱': 'Choline, total',
        'choline': 'Choline, total',
    };
    
    private async ensureFoods(loader?: FoodDataLoader): Promise<USDAFood[]> {
        if (loader) return loader.getFoods();
        return this.fallbackFoods;
    }
    
    private tokenMatch(foodName: string, keyword: string): boolean {
        // 按逗号、空格、括号、斜杠等分隔符拆解为独立 token
        const tokens = foodName.toLowerCase().split(/[,\s\(\)\/]+/);
        return tokens.some(t => t === keyword);
    }

    private searchUSDA(keyword: string, foods: USDAFood[]): USDAFood | null {
        const kw = keyword.toLowerCase().trim();
        if (!kw) return null;
        
        // 0. 快速识别无热量基础液体/调料（水、盐、冰），避免误匹配到含盐炸薯条或面筋
        if (['water', '水', '清水', '饮用水', '开水', '白开水', '冷水', '热水', '温水', '蒸锅用水',
             '高汤', '清汤', '骨汤', '冰', '冰块', '葱姜水', '葱姜蒜',
             'salt', '食盐', '盐', '食用盐', '料酒', '黄酒', 'cooking wine',
             '蘸料碟', '其他调料', '香叶', '八角', '桂皮', '月桂叶', '丁香', '茴香',
             '干辣椒', '花椒', '青花椒', '花椒油', '藤椒油', '芥末油',
             '辣椒粉', '五香粉', '十三香', '白胡椒粉', '黑胡椒粉', '黑胡椒',
             '孜然粉', '孜然籽', '小苏打', '干酵母', '泡打粉',
             '葱结', '姜片', '蒜瓣', '蒜末', '蒜粉', '姜末', '葱花', '香菜叶'].includes(kw)) {
            return { n: kw, d: { Energy: 0 } } as USDAFood;
        }

        // 1. O(1) 极端精确命中与多词完全拆分匹配
        const exactMatch = foods.find(f => f.n.toLowerCase() === kw);
        if (exactMatch) return exactMatch;
        
        // 2. 候选池预过滤 (将复杂度从 O(N) 压到 O(50))
        //    多词查询拆分为独立单词分别命中，兼容 USDA 逗号分隔格式
        //    例: "pork belly" → ["pork","belly"] → 能命中 "Pork, fresh, belly, raw"
        const kwWords = kw.split(/[\s,]+/).filter(w => w.length > 1);
        const isMultiWord = kwWords.length > 1;
        let candidates: USDAFood[];
        if (isMultiWord) {
            candidates = foods.filter(f => {
                const name = f.n.toLowerCase();
                return kwWords.every(w => name.includes(w));
            });
        } else {
            candidates = foods.filter(f => f.n.toLowerCase().includes(kw));
        }
        if (candidates.length === 0) return null;

        let bestMatch: USDAFood | null = null;
        let bestScore = 0;

        for (const food of candidates) {
            const nameLower = food.n.toLowerCase();
            let score = 0;

            if (isMultiWord) {
                // 多词按每个词分别评估是否满足词边界，全部满足则叠加高分
                const allBoundaries = kwWords.every(w => this.tokenMatch(nameLower, w));
                if (allBoundaries) score += 120;
            } else {
                // 单词评估词边界
                if (this.tokenMatch(nameLower, kw)) score += 100;
            }
            
            // 主类别首段匹配 ("Beef, ground")
            const firstSegment = (nameLower.split(',')[0] || '').trim();
            if (firstSegment === kw || this.tokenMatch(firstSegment, kw)) score += 50;
            
            // 中国本土数据源加权
            if (food.m?.dataType === 'China_Embedded') score += 30;
            
            // 名称以关键词开头
            if (nameLower.startsWith(kw)) score += 20;
            
            // 基础包含兜底分
            score += 10;
            
            // 结合共词相似度打分贡献 (0~40)
            score += this.calculateSimilarity(kw, nameLower) * 40;
            
            if (score > bestScore) {
                bestScore = score;
                bestMatch = food;
            }
            // 不再提前 break，因为候选池仅约 50 个，全量遍历极快且保证取到全局最高分
        }
        
        return bestScore >= 40 ? bestMatch : null;
    }
    
    // 计算字符串相似度（基于共同词汇）
    private calculateSimilarity(query: string, target: string): number {
        const queryWords = new Set(query.split(/[\s,]+/).filter(w => w.length > 1));
        const targetWords = target.split(/[\s,]+/).filter(w => w.length > 1);
        
        if (queryWords.size === 0) return 0;
        
        let matches = 0;
        for (const tw of targetWords) {
            for (const qw of queryWords) {
                // 完全匹配，或较长词前缀匹配（避免 fish 匹配 Goldfish）
                if (tw === qw || (qw.length >= 3 && tw.startsWith(qw)) || (tw.length >= 3 && qw.startsWith(tw))) {
                    matches++;
                    break;
                }
            }
        }
        
        return matches / queryWords.size;
    }
    
    /**
     * 名称净化器：剥离口语化杂质与量词备注，还原干净食材名。
     * 只剥离明确的非食材模式，不做语义变换（不去掉"新鲜""冷冻""干"等前缀）。
     * 同时处理多选拆分："A或B" / "A/B" → ["A", "B"]
     */
    private _sanitizeIngredientName(raw: string): string[] {
        let s = raw
            .replace(/`/g, "")
            .replace(/\d+°C/g, "")
            .replace(/\d+(?:\.\d+)?\s*(?:g|克|ml|毫升|kg|公斤)/gi, "")
            .replace(/[=＝]\s*份数\s*[*×xX]?/g, "")
            .replace(/[*×xX]\s*$/g, "")
            .replace(/份数/g, "")
            .replace(/\d+\s*[人份颗根条只个]/g, "")
            .replace(/用量为/g, "")
            .replace(/颗\/人/g, "")
            .replace(/每颗/g, "")
            .replace(/汤匙/g, "")
            .replace(/茶匙/g, "")
            .replace(/根据.*口味.*加减/g, "")
            .replace(/[～~\-+]\s*$/g, "")
            .replace(/[：:]\s*$/g, "")
            .replace(/\s+/g, " ")
            .trim();
        // 去掉末尾残留: 数字、斜杠、约、一盒等口语化修饰词
        s = s.replace(/[\d\s\/\-～~]+$/g, "").trim();
        s = s.replace(/[\s\/]*约\s*$/g, "").trim();
        s = s.replace(/\s*一盒\s*/g, "").trim();
        if (!s || s.length === 0) return [raw.trim()];

        // 多选拆分: "黄酒或料酒" → ["黄酒","料酒"]; "五花肉/瘦肉" → ["五花肉","瘦肉"]
        const parts = s.split(/[或\/]/).map(x => x.trim()).filter(x => x.length > 0);
        if (parts.length > 1) return parts;
        return [s];
    }

    private searchChinese(cn: string, foods: USDAFood[]): USDAFood | null {
        // 0. 名称净化 + 多选拆分: 对每个候选名依次尝试，首个命中即返回
        const sanitizedNames = this._sanitizeIngredientName(cn);
        for (const name of sanitizedNames) {
            const result = this._searchChineseSingle(name, foods);
            if (result) return result;
        }
        return null;
    }

    /** 单个候选名的匹配逻辑（净化器拆分后的原子查询） */
    private _searchChineseSingle(cn: string, foods: USDAFood[]): USDAFood | null {
        // v4.0: 优先走 FoodDatabase O(1) 索引（已预计算中文映射 + 倒排索引）
        const fdbResult = getFoodDatabase().lookupChinese(cn);
        if (fdbResult) {
          return {
            n: fdbResult.name,
            d: fdbResult.nutrients,
            m: { dataType: fdbResult.source === "china" ? "China_Embedded" : "FDC_Embedded" },
          };
        }

        // 0. 回退：直接用中文名搜 foods（china-foods.json 的 1725 条数据）
        const directMatch = this.searchUSDA(cn, foods);
        if (directMatch) return directMatch;

        // 1. 回退：直接映射到英文
        const en = FOOD_CN_MAP[cn];
        if (en) return this.searchUSDA(en, foods);

        // 2. 部分匹配映射 — 最长键优先，确保 "鸡胸肉"(3字) 优先于 "鸡肉"(2字)
        const partialKeys = Object.keys(FOOD_CN_MAP)
            .filter(k => k.length >= 1 && cn.includes(k))
            .sort((a, b) => b.length - a.length);  // 降序：长键优先
        for (const cnKey of partialKeys) {
            const result = this.searchUSDA(FOOD_CN_MAP[cnKey]!, foods);
            if (result) return result;
        }

        // 3. 尝试用拼音或常见英文名搜索
        const commonTranslations: Record<string, string[]> = {
            '肉': ['meat', 'pork', 'beef'],
            '菜': ['vegetable', 'greens'],
            '饭': ['rice'],
            '面': ['noodle', 'flour'],
            '汤': ['soup'],
            '粥': ['porridge', 'congee'],
            '蛋': ['egg'],
            '奶': ['milk', 'dairy'],
            '油': ['oil'],
            '酱': ['sauce'],
            '糖': ['sugar'],
            '盐': ['salt'],
        };
        
        for (const [cnChar, enWords] of Object.entries(commonTranslations)) {
            if (cn.includes(cnChar)) {
                for (const enWord of enWords) {
                    const result = this.searchUSDA(enWord, foods);
                    if (result) return result;
                }
            }
        }

        // 4. 字符级兜底: 当英文映射均失败时，尝试用中文名的逐级短子串直接搜中文数据库
        //    例: "黄豆酱" → 搜 "黄豆"(2字) → china-foods.json 命中 "黄豆" → 返回 soybean
        if (cn.length >= 2) {
            for (let len = cn.length - 1; len >= 2; len--) {
                for (let start = 0; start <= cn.length - len; start++) {
                    const sub = cn.substring(start, start + len);
                    const result = this.searchUSDA(sub, foods);
                    if (result) return result;
                }
            }
        }

        return null;
    }
    
    parseMenu(text: string): MenuIngredient[] {
        return text.trim().split('\n')
            .map(line => line.match(/^(.+?)\s*(\d+(?:\.\d+)?)\s*[gG克]?$/))
            .filter(m => m)
            .map(m => ({ name: (m?.[1] || '').trim(), amount: parseFloat(m?.[2] || '0') }));
    }
    
    private canonicalBooheeName(name?: string, nameEn?: string): string | null {
        const candidates = [nameEn, name].filter(Boolean) as string[];
        for (const raw of candidates) {
            const lower = raw.toLowerCase();
            if (this.booheeAlias[lower]) return this.booheeAlias[lower];
        }
        return candidates[0] || null;
    }
    
    private mergeBooheeItems(target: NutritionResult, items?: BooheeNutrientItem[]) {
        for (const item of items || []) {
            const name = this.canonicalBooheeName(item.name, item.name_en);
            if (!name || typeof item.value !== 'number') continue;
            target[name] = (target[name] || 0) + item.value;
            if (item.items?.length) this.mergeBooheeItems(target, item.items);
        }
    }
    
    private async fetchFromBoohee(name: string, client: BooheeClient): Promise<USDAFood | null> {
        try {
            const search = await client.searchFood(name);
            const target = search.foods?.[0];
            if (!target) return null;
            const detail = await client.getFoodDetail(target.code);
            const nutrients: NutritionResult = {};
            this.mergeBooheeItems(nutrients, detail.calory);
            this.mergeBooheeItems(nutrients, detail.base_ingredients);
            this.mergeBooheeItems(nutrients, detail.vitamin);
            this.mergeBooheeItems(nutrients, detail.mineral);
            this.mergeBooheeItems(nutrients, detail.other_ingredients);
            this.mergeBooheeItems(nutrients, detail.amino_acid);
            if (Object.keys(nutrients).length === 0) return null;
            return { n: detail.food?.name || target.name, d: nutrients };
        } catch (err) {
            if (!this.lastBooheeError) {
                this.lastBooheeError = err instanceof Error ? err.message : String(err);
            }
            console.warn('[MenuCalculator] Boohee fetch failed', err);
            return null;
        }
    }
    
    async calculate(text: string, opts: CalcOptions = {}): Promise<{ ingredients: MenuIngredient[], total: NutritionResult, unmatched: string[] }> {
        this.lastBooheeError = null;
        const foods = await this.ensureFoods(opts.loader);
        const ingredients = this.parseMenu(text);
        const total: NutritionResult = {};
        const unmatched: string[] = [];
        const defaultSource: MenuIngredient['source'] = opts.loader ? 'fooddata' : 'usda';
        
        for (const ing of ingredients) {
            let food = this.searchChinese(ing.name, foods) || this.searchUSDA(ing.name, foods);
            let source: MenuIngredient['source'] | undefined;
            if (food) {
                if (food.m?.dataType === 'China_Embedded') source = 'china';
                else source = opts.loader ? 'fooddata' : 'usda';
            }
            if (!food && opts.boohee) {
                food = await this.fetchFromBoohee(ing.name, opts.boohee);
                source = food ? 'boohee' : undefined;
            }
            if (food) {
                ing.matched = food.n;
                ing.source = source || defaultSource;
                ing.nutrients = food.d;  // 保存营养数据以便后续重新匹配
                const ratio = ing.amount / 100;
                for (const [k, v] of Object.entries(food.d)) {
                    total[k] = (total[k] || 0) + v * ratio;
                }
            } else {
                unmatched.push(ing.name);
            }
        }
        
        for (const k of Object.keys(total)) {
            const val = total[k];
            if (val !== undefined) total[k] = Math.round(val * 100) / 100;
        }
        return { ingredients, total, unmatched };
    }

    getLastBooheeError() {
        return this.lastBooheeError;
    }

    // 单独匹配一个食材
    matchSingleIngredient(name: string, foods: USDAFood[]): { matched: string; nutrients: Record<string, number> } | null {
        const food = this.searchChinese(name, foods) || this.searchUSDA(name, foods);
        if (!food) return null;
        return { matched: food.n, nutrients: food.d };
    }

    // 汇总所有食材的营养素
    sumNutrients(ingredients: MenuIngredient[]): NutritionResult {
        const total: NutritionResult = {};
        for (const ing of ingredients) {
            if (!ing.nutrients) continue;
            const ratio = ing.amount / 100;
            for (const [k, v] of Object.entries(ing.nutrients)) {
                if (typeof v === 'number') {
                    total[k] = (total[k] || 0) + v * ratio;
                }
            }
        }
        for (const k of Object.keys(total)) {
            const val = total[k];
            if (val !== undefined) total[k] = Math.round(val * 100) / 100;
        }
        return total;
    }
    
    compareDRIs(nutrition: NutritionResult, pop: string = '成年男性') {
        const dri = DRIs[pop] || DRIs['成年男性'] || {};
        const result: Record<string, { value: number, dri: number, percent: number }> = {};
        for (const [k, v] of Object.entries(dri)) {
            result[k] = { value: nutrition[k] || 0, dri: v, percent: Math.round((nutrition[k] || 0) / v * 100) };
        }
        return result;
    }
    
    toMarkdown(total: NutritionResult, ingredients: MenuIngredient[], unmatched: string[], driPop?: string): string {
        let md = '## 营养计算结果\n\n### 食材\n| 食材 | 用量 | 匹配 |\n|---|---|---|\n';
        for (const i of ingredients) {
            const source = i.source ? ` (${i.source})` : '';
            md += `| ${i.name} | ${i.amount}g | ${i.matched ? i.matched + source : '❌'} |\n`;
        }
        if (unmatched.length) md += `\n> ⚠️ 未匹配: ${unmatched.join(', ')}\n`;
        
        md += '\n### 营养汇总\n| 营养素 | 含量 |';
        const dri = driPop ? this.compareDRIs(total, driPop) : null;
        if (dri) md += ' DRI% |';
        md += '\n|---|---|';
        if (dri) md += '---|';
        md += '\n';

        const orderedKeys: string[] = [];
        if (dri) orderedKeys.push(...Object.keys(dri));
        for (const k of Object.keys(total)) {
            if (!orderedKeys.includes(k)) orderedKeys.push(k);
        }

        for (const k of orderedKeys) {
            const v = total[k];
            if (typeof v !== 'number') continue;
            md += `| ${formatNutrientLabel(k)} | ${v} ${UNITS[k] || ''} |`;
            if (dri && dri[k]) md += ` ${dri[k].percent}% |`;
            md += '\n';
        }
        return md;
    }
}

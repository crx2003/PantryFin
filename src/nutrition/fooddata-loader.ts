// FoodData Central loader to enrich the local nutrition database
// 注意：移动端没有 fs/path 模块，使用惰性 require + try-catch 避免崩溃
import { USDA_FOODS } from './usda-mini';
import { FDCFoodEntry, setFDCFoods, getFDCFoods } from './fdc-data';
import chinaFoodsEmbedded from './china-foods.json';

export interface USDAFood {
    n: string;
    d: Record<string, number>;
    m?: {
        sourceFile?: string;
        fdcId?: number;
        dataType?: string;
        foodCategory?: string;
        nutrients?: { name: string; amount: number; unit?: string }[];
    };
}

export interface FoodDataPaths {
    foundationDataPath?: string;
    legacyDataPath?: string;
    dataPaths?: string[];
    pluginDir?: string;  // 插件目录，用于加载内嵌的 JSON 数据
    adapter?: any;       // Obsidian Vault Adapter (移动端跨平台读取文件系统)
}

const NUTRIENT_WHITELIST = new Set([
    'Energy',
    'Protein',
    'Total lipid (fat)',
    'Carbohydrate, by difference',
    'Fiber, total dietary',
    'Cholesterol',
    'Vitamin A, RAE',
    'Vitamin D (D2 + D3)',
    'Vitamin E (alpha-tocopherol)',
    'Vitamin K (phylloquinone)',
    'Thiamin',
    'Riboflavin',
    'Vitamin B-6',
    'Vitamin B-12',
    'Vitamin C, total ascorbic acid',
    'Pantothenic acid',
    'Folate, total',
    'Niacin',
    'Biotin',
    'Calcium, Ca',
    'Phosphorus, P',
    'Potassium, K',
    'Sodium, Na',
    'Magnesium, Mg',
    'Chloride, Cl',
    'Iron, Fe',
    'Iodine, I',
    'Zinc, Zn',
    'Selenium, Se',
    'Copper, Cu',
    'Manganese, Mn',
    'Choline, total',
]);

// 将 FDC 数据转换为 USDAFood 格式
// FDC_FOODS 格式: [[name, {nutrient: value}], ...]
function convertFDCToUSDA(fdcFoods: FDCFoodEntry[], dataType: string): USDAFood[] {
    return fdcFoods.map((item) => ({
        n: item[0],
        d: item[1],
        m: { dataType }
    }));
}

function canonicalName(name?: string): string | null {
    if (!name) return null;
    const normalized = name.toLowerCase().trim();
    const aliases: Record<string, string> = {
        'energy': 'Energy',
        'protein': 'Protein',
        'total lipid (fat)': 'Total lipid (fat)',
        'total fat': 'Total lipid (fat)',
        'fatty acids, total saturated': 'Total lipid (fat)',
        'carbohydrate, by difference': 'Carbohydrate, by difference',
        'carbohydrate': 'Carbohydrate, by difference',
        'fiber, total dietary': 'Fiber, total dietary',
        'dietary fiber': 'Fiber, total dietary',
        'cholesterol': 'Cholesterol',
        'vitamin a, rae': 'Vitamin A, RAE',
        'vitamin a': 'Vitamin A, RAE',
        'vitamin d (d2 + d3)': 'Vitamin D (D2 + D3)',
        'vitamin d': 'Vitamin D (D2 + D3)',
        'vitamin e (alpha-tocopherol)': 'Vitamin E (alpha-tocopherol)',
        'vitamin e': 'Vitamin E (alpha-tocopherol)',
        'vitamin k (phylloquinone)': 'Vitamin K (phylloquinone)',
        'vitamin k': 'Vitamin K (phylloquinone)',
        'thiamin': 'Thiamin',
        'vitamin b1': 'Thiamin',
        'riboflavin': 'Riboflavin',
        'vitamin b2': 'Riboflavin',
        'vitamin b-6': 'Vitamin B-6',
        'vitamin b6': 'Vitamin B-6',
        'vitamin b-12': 'Vitamin B-12',
        'vitamin b12': 'Vitamin B-12',
        'vitamin c, total ascorbic acid': 'Vitamin C, total ascorbic acid',
        'vitamin c': 'Vitamin C, total ascorbic acid',
        'pantothenic acid': 'Pantothenic acid',
        'folate, total': 'Folate, total',
        'folate': 'Folate, total',
        'niacin': 'Niacin',
        'biotin': 'Biotin',
        'calcium, ca': 'Calcium, Ca',
        'calcium': 'Calcium, Ca',
        'phosphorus, p': 'Phosphorus, P',
        'phosphorus': 'Phosphorus, P',
        'potassium, k': 'Potassium, K',
        'potassium': 'Potassium, K',
        'sodium, na': 'Sodium, Na',
        'sodium': 'Sodium, Na',
        'magnesium, mg': 'Magnesium, Mg',
        'magnesium': 'Magnesium, Mg',
        'chloride, cl': 'Chloride, Cl',
        'chloride': 'Chloride, Cl',
        'iron, fe': 'Iron, Fe',
        'iron': 'Iron, Fe',
        'iodine, i': 'Iodine, I',
        'iodine': 'Iodine, I',
        'zinc, zn': 'Zinc, Zn',
        'zinc': 'Zinc, Zn',
        'selenium, se': 'Selenium, Se',
        'selenium': 'Selenium, Se',
        'copper, cu': 'Copper, Cu',
        'copper': 'Copper, Cu',
        'manganese, mn': 'Manganese, Mn',
        'manganese': 'Manganese, Mn',
        'choline, total': 'Choline, total',
        'choline': 'Choline, total',
    };
    return aliases[normalized] || name;
}

function pickNutrients(items: any[]): Record<string, number> {
    const result: Record<string, number> = {};
    for (const item of items || []) {
        const nutrient = item.nutrient || {};
        const name = canonicalName(nutrient.name);
        const amount = typeof item.amount === 'number' ? item.amount : null;
        if (!name || amount === null) continue;
        // only keep whitelisted nutrients to keep memory lower
        if (NUTRIENT_WHITELIST.size === 0 || NUTRIENT_WHITELIST.has(name)) {
            result[name] = amount;
        }
    }
    return result;
}

export class FoodDataLoader {
    private cache: USDAFood[] | null = null;
    private loading: Promise<USDAFood[]> | null = null;
    private lastErrors: string[] = [];
    private lastCount = 0;
    private usedFallback = false;
    private usedMiniIndex = false;
    constructor(private getPaths: () => FoodDataPaths) {}

    invalidate() { this.cache = null; }

    getLastDiagnostics() {
        return {
            errors: [...this.lastErrors],
            loadedCount: this.lastCount,
            usedFallback: this.usedFallback
        };
    }

    /** 是否使用了 mini-index (仅含 Energy)，可用于判断是否需要懒加载完整数据 */
    isUsingMiniIndex(): boolean { return this.usedMiniIndex; }

    async getFoods(): Promise<USDAFood[]> {
        if (this.cache) return this.cache;
        if (!this.loading) this.loading = this.loadAll();
        this.cache = await this.loading;
        this.loading = null;
        return this.cache;
    }

    /** P1: 按需加载完整 FDC 数据 (含全部营养素)，替换 mini-index 中的精简条目 */
    async loadFullFDCDetails(): Promise<void> {
        const { pluginDir, adapter } = this.getPaths() as any;
        const fullCand = pluginDir ? `${pluginDir}/fdc-data.json` : "fdc-data.json";

        try {
            let raw = "";
            if (adapter && typeof adapter.exists === 'function' && typeof adapter.read === 'function') {
                if (await adapter.exists(fullCand)) {
                    raw = await adapter.read(fullCand);
                }
            }
            if (!raw) return;

            const fullData = JSON.parse(raw) as FDCFoodEntry[];
            setFDCFoods(fullData);
            this.usedMiniIndex = false;
            this.cache = null;
            this.loading = null;
            console.log(`[FoodDataLoader] Upgraded to full FDC data: ${fullData.length} items with complete nutrients`);
        } catch (err) {
            console.warn('[FoodDataLoader] Failed to load full FDC details:', err);
        }
    }

    private async loadAll(): Promise<USDAFood[]> {
        const { foundationDataPath, legacyDataPath, dataPaths, pluginDir, adapter } = this.getPaths() as any;
        const files = [
            ...(dataPaths || []),
            foundationDataPath,
            legacyDataPath
        ].filter(Boolean) as string[];
        const uniqFiles = Array.from(new Set(files));
        this.lastErrors = [];
        this.lastCount = 0;
        this.usedFallback = false;
        
        // 优先加载内嵌的 FDC JSON 数据（8000+ 食物）
        let fdcFoods = getFDCFoods();
        if (fdcFoods.length === 0) {
            try {
                // P1 移动端: 优先加载轻量索引 fdc-mini-index.json (~582KB vs 4MB)
                // 仅包含 name + Energy，大幅减少移动端内存占用与冷启动开销
                if (adapter && typeof adapter.exists === 'function' && typeof adapter.read === 'function') {
                    const miniCand = pluginDir ? `${pluginDir}/fdc-mini-index.json` : "fdc-mini-index.json";
                    const fullCand = pluginDir ? `${pluginDir}/fdc-data.json` : "fdc-data.json";

                    // 1a. 尝试加载 mini-index (移动端优先)
                    if (await adapter.exists(miniCand)) {
                        const raw = await adapter.read(miniCand);
                        fdcFoods = JSON.parse(raw) as FDCFoodEntry[];
                        setFDCFoods(fdcFoods);
                        this.usedMiniIndex = true;
                        console.log(`[FoodDataLoader] Loaded FDC mini-index: ${fdcFoods.length} items (mobile-optimized)`);
                    } else if (await adapter.exists(fullCand)) {
                        // 1b. 回退到完整 FDC 数据
                        const raw = await adapter.read(fullCand);
                        fdcFoods = JSON.parse(raw) as FDCFoodEntry[];
                        setFDCFoods(fdcFoods);
                    }
                }
            } catch (err) {
                console.warn('[FoodDataLoader] Failed to load fdc-data.json:', err);
            }
        }
        const foods: USDAFood[] = fdcFoods.length > 0
            ? convertFDCToUSDA(fdcFoods, 'FDC_Embedded')
            : [];

        try {
            const chinaFoods = chinaFoodsEmbedded as unknown as FDCFoodEntry[];
            foods.push(...convertFDCToUSDA(chinaFoods, 'China_Embedded'));
        } catch (err) {
            console.warn('[FoodDataLoader] Failed to load embedded china-foods.json:', err);
        }
        
        // 如果用户配置了额外的数据文件，也加载它们
        for (const file of uniqFiles) {
            try {
                const loaded = await this.loadFile(file);
                if (!loaded.length) this.lastErrors.push(`未从文件读取到数据: ${file}`);
                foods.push(...loaded);
            } catch (err) {
                const message = err instanceof Error ? err.message : String(err);
                this.lastErrors.push(`加载失败: ${file} (${message})`);
                console.error('[FoodDataLoader] Failed to load', file, err);
            }
        }
        
        // 始终合并 USDA_FOODS 英文数据库，确保 FOOD_CN_MAP 的英文映射词条能命中
        // China_Embedded 数据负责中文→中文直接匹配，USDA 负责中文→英文映射后的匹配
        foods.push(...(USDA_FOODS as USDAFood[]));
        this.lastCount = foods.length;
        return foods;
    }

    private async loadFile(file: string): Promise<USDAFood[]> {
        const { adapter } = this.getPaths() as any;
        let raw = "";
        if (adapter && typeof adapter.exists === 'function' && typeof adapter.read === 'function' && await adapter.exists(file)) {
            raw = await adapter.read(file);
        }
        if (!raw) return [];
        const parsed = JSON.parse(raw);
        const list = parsed.FoundationFoods || parsed.SRLegacyFoods || parsed.foods || [];
        const foods: USDAFood[] = [];
        for (const item of list) {
            const nutrients = pickNutrients(item.foodNutrients || []);
            const rawNutrients = (item.foodNutrients || []).map((entry: any) => ({
                name: entry.nutrient?.name,
                amount: entry.amount,
                unit: entry.nutrient?.unitName || entry.nutrient?.unit_name
            })).filter((entry: any) => entry.name && typeof entry.amount === 'number');
            foods.push({
                n: item.description || 'Unknown',
                d: nutrients,
                m: {
                    sourceFile: file,
                    fdcId: item.fdcId,
                    dataType: item.dataType,
                    foodCategory: item.foodCategory?.description,
                    nutrients: rawNutrients
                }
            });
        }
        return foods;
    }
}

// src/services/ContextPackager.ts
//
// Layer 1: 本地预计算上下文引擎。
// 在发给 AI 之前，本地计算所有可确定的数据 (BMR/TDEE/宏量素目标)，
// 分析库存紧急度和分类摘要，输出精简的 ContextPackage。
// 目标：Prompt 缩减 60%，消除 AI 计算错误。

import { UserProfile, PantryItem } from "../models/types";
import { MenuCalculator } from "../nutrition/menu-calculator";
import { FoodDataLoader } from "../nutrition/fooddata-loader";

// ── 预计算结果 ────────────────────────────────────────────
export interface ComputedTargets {
  bmr: number;              // Mifflin-St Jeor 基础代谢
  tdee: number;             // 每日总消耗
  targetCalories: number;   // 目标热量（已按目标调整）
  macroTargets: {
    protein_g: number;
    carbs_g: number;
    fat_g: number;
  };
}

// ── 库存分析摘要 ──────────────────────────────────────────
export interface PantryDigest {
  urgentItems: { name: string; qty: string; expiry: string }[];
  categories: Record<string, string[]>;
  totalItemCount: number;
  // 只发送给 AI 的精简文本（非全表）
  summaryText: string;
}

// ── AI 上下文包 ───────────────────────────────────────────
export interface ContextPackage {
  date: string;
  computed: ComputedTargets;
  pantryDigest: PantryDigest;
  memorySlice: string;
  rulesText: string;
  profileSummary: string;
  /** 库存食材营养参考: "鸡胸肉(每100g): 133kcal 蛋白质31g 脂肪1g" */
  nutritionRefs: string;
}

// ══════════════════════════════════════════════════════════
export class ContextPackager {
  // ── Mifflin-St Jeor 公式 ──────────────────────────────
  computeBMR(profile: UserProfile): number {
    const { weight_kg, height_cm, age, gender } = profile.body;
    const base = 10 * weight_kg + 6.25 * height_cm - 5 * age;
    return Math.round(gender === "male" ? base + 5 : base - 161);
  }

  // ── 活动系数 ──────────────────────────────────────────
  private activityMultiplier(level: string): number {
    const map: Record<string, number> = {
      sedentary: 1.2,
      light: 1.375,
      moderate: 1.55,
      active: 1.725,
      very_active: 1.9,
    };
    return map[level] ?? 1.55;
  }

  // ── TDEE = BMR × 活动系数 ─────────────────────────────
  computeTDEE(bmr: number, activityLevel: string): number {
    return Math.round(bmr * this.activityMultiplier(activityLevel));
  }

  // ── 目标热量 = TDEE ± 目标调整 ────────────────────────
  computeTargetCalories(tdee: number, goalType: string, weeklyRateKg: number): number {
    // 每周减/增 0.5kg ≈ 每天 ±500kcal (1kg 脂肪 ≈ 7700kcal)
    const dailyAdjustment = Math.round((weeklyRateKg * 7700) / 7);
    return tdee + dailyAdjustment;
  }

  // ── 宏量素目标分配 ────────────────────────────────────
  computeMacroTargets(targetCalories: number, weightKg: number, goalType: string): {
    protein_g: number; carbs_g: number; fat_g: number;
  } {
    // 蛋白质: 根据目标调整 g/kg
    let proteinPerKg = 1.6; // 默认维持
    if (goalType === "muscle_gain") proteinPerKg = 2.0;
    if (goalType === "fat_loss") proteinPerKg = 1.8;

    const protein_g = Math.round(weightKg * proteinPerKg);
    const proteinCals = protein_g * 4;

    // 脂肪: 25% 总热量
    const fatCals = targetCalories * 0.25;
    const fat_g = Math.round(fatCals / 9);

    // 碳水: 剩余热量
    const carbCals = targetCalories - proteinCals - fatCals;
    const carbs_g = Math.round(Math.max(50, carbCals / 4)); // 最低 50g

    return { protein_g, carbs_g, fat_g };
  }

  // ── 库存分析摘要 ──────────────────────────────────────
  analyzePantry(pantry: PantryItem[]): PantryDigest {
    const urgentItems: PantryDigest["urgentItems"] = [];
    const categories: Record<string, string[]> = {};

    for (const item of pantry) {
      // 分类聚合
      if (!categories[item.category]) categories[item.category] = [];
      categories[item.category]!.push(item.name);

      // 临期标记
      if (item.priority?.includes("急需") || item.priority?.includes("尽快")) {
        urgentItems.push({
          name: item.name,
          qty: item.quantity,
          expiry: item.expiryDate,
        });
      }
    }

    // 生成给 AI 的精简摘要文本
    // 列出所有库存食材（名称+数量），AI 只能使用这些
    const allItemList = pantry
      .filter(p => (parseFloat(p.quantity) || 0) > 0)
      .map(p => `${p.name}(${p.quantity})`)
      .join("、");
    let summaryText = `📦 可用食材（仅限使用以下食材，不可虚构）：${allItemList || "（空仓）"}`;
    // 数量偏低的额外标记
    const lowStockItems = pantry.filter(p => {
      const n = parseFloat(p.quantity) || 0;
      return n > 0 && n < 100;
    });
    if (lowStockItems.length > 0) {
      summaryText += `\n⚠️ 库存偏低优先消耗: ${lowStockItems.map(i => `${i.name}(${i.quantity})`).join("、")}`;
    }

    return {
      urgentItems,
      categories,
      totalItemCount: pantry.length,
      summaryText,
    };
  }

  // ── 档案摘要 ──────────────────────────────────────────
  private summarizeProfile(profile: UserProfile): string {
    const goalMap: Record<string, string> = {
      fat_loss: "减脂", muscle_gain: "增肌", maintenance: "维持体重",
    };
    return `${profile.body.gender === "male" ? "男" : "女"} ${profile.body.age}岁 ${profile.body.height_cm}cm ${profile.body.weight_kg}kg 目标${goalMap[profile.goal.type] || profile.goal.type} 饮食风格${profile.preferences.dietary_style}`;
  }

  // ── 构建完整上下文包 ──────────────────────────────────
  async build(
    profile: UserProfile,
    pantry: PantryItem[],
    date: string,
    memorySlice: string,
    rulesText: string,
    menuCalc?: MenuCalculator,
    foodLoader?: FoodDataLoader
  ): Promise<ContextPackage> {
    const bmr = this.computeBMR(profile);
    const tdee = this.computeTDEE(bmr, profile.body.activity_level);
    const targetCalories = this.computeTargetCalories(tdee, profile.goal.type, profile.goal.weekly_rate_kg);
    const macroTargets = this.computeMacroTargets(targetCalories, profile.body.weight_kg, profile.goal.type);

    // 构建营养参考: 库存食材的每100g营养数据
    let nutritionRefs = "";
    if (menuCalc && foodLoader) {
      const foods = await foodLoader.getFoods();
      const refs: string[] = [];
      for (const item of pantry) {
        const match = menuCalc.matchSingleIngredient(item.name, foods);
        if (match) {
          const n = match.nutrients;
          const cal = n["Energy"] ? `${Math.round(n["Energy"])}kcal` : "";
          const pro = n["Protein"] ? `蛋白质${Math.round(n["Protein"])}g` : "";
          const fat = n["Total lipid (fat)"] ? `脂肪${Math.round(n["Total lipid (fat)"]!)}g` : "";
          const carb = n["Carbohydrate, by difference"] ? `碳水${Math.round(n["Carbohydrate, by difference"]!)}g` : "";
          const parts = [cal, pro, fat, carb].filter(Boolean);
          if (parts.length > 0) refs.push(`${item.name}(每100g): ${parts.join(" ")}`);
        }
      }
      nutritionRefs = refs.join("\n");
    }

    return {
      date,
      computed: { bmr, tdee, targetCalories, macroTargets },
      pantryDigest: this.analyzePantry(pantry),
      memorySlice,
      rulesText,
      profileSummary: this.summarizeProfile(profile),
      nutritionRefs,
    };
  }

  // ── 生成精简 AI Prompt（替代原来的 buildPrompt）────────
  buildCompactPrompt(pkg: ContextPackage): string {
    const { computed, pantryDigest } = pkg;

    const profileBlock = `## 用户档案
${pkg.profileSummary}
（以下数据已由本地引擎精确计算，请直接使用，无需重复计算）
- 基础代谢 BMR: ${computed.bmr} kcal
- 每日消耗 TDEE: ${computed.tdee} kcal
- 目标热量: ${computed.targetCalories} kcal
- 宏量素目标: 蛋白质 ${computed.macroTargets.protein_g}g | 碳水 ${computed.macroTargets.carbs_g}g | 脂肪 ${computed.macroTargets.fat_g}g`;

    const pantryBlock = `## 库存摘要
${pantryDigest.summaryText}`;

    const nutritionBlock = pkg.nutritionRefs
      ? `\n## 库存食材营养参考（每100g，已由本地数据库精确计算）\n${pkg.nutritionRefs}\n`
      : "";

    const memBlock = pkg.memorySlice
      ? `\n## 近期记忆\n${pkg.memorySlice}\n`
      : "";

    const rulesBlock = pkg.rulesText
      ? `\n### 🚨 永久铁律\n${pkg.rulesText}\n`
      : "";

    return `你是专业的运动和营养膳食规划 AI。请为 ${pkg.date} 设计完整的一日三餐。

${rulesBlock}
${profileBlock}

${pantryBlock}
${nutritionBlock}
${memBlock}
## 🚨 铁律（违反任一条=不合格）
1. 【食材来源：只许用库存中存在的】今天的三餐原料必须100%来自上方 📦 可用食材列表。唯一例外：基础调料（盐糖酱油醋料酒蚝油食用油胡椒粉花椒八角桂皮香叶味精鸡精淀粉香油）。禁止使用列表外的任何食材！不要凭空添加"牛肉""三文鱼""西兰花"等不在列表中的食材。
2. BMR/TDEE/目标热量已由本地引擎精确计算，直接使用，无需重复计算。
3. 优先消耗 ⚠️ 标记的库存偏低食材。
4. 每道菜写明精确原料清单，量化到克(g)/毫升(ml)。
5. 操作步骤附带终止条件断言（如：直到筷子能轻松穿透）。

## 输出格式
你必须输出一个纯 JSON 对象（不要用 \`\`\`json 包裹）。markdown_content 中每餐必须严格按以下模板：

# 🥗 YYYY-MM-DD 饮食设计安排

## 📊 今日营养代谢指标
- **基础代谢 (BMR)**: xxx kcal
- **目标热量 (TDEE±)**: xxx kcal
- **三大营养素目标**: 蛋白质 xxg | 碳水 xxg | 脂肪 xxg

## 🍳 早餐 (预计 xxx kcal)
- **菜品名称与难度**: ...
- **精确原料清单**: 食材名 数字g、食材名 数字ml...
- **程序化操作步骤**: 1. ... 2. ...

## 🥗 午餐 (预计 xxx kcal)
（同上格式）

## 🌙 晚餐 (预计 xxx kcal)
（同上格式）

JSON 格式（注意：amount_g 的数字必须与上面「可用食材」列表中该食材的单位一致。如库存是 牛奶(1000ml)，则消耗 200 就写 200，不要转成克）：
{
  "markdown_content": "完整的 Markdown 菜谱正文",
  "consume": [{"name": "食材名", "amount_g": 数字}]
}`;
  }

  // ── v4.2 单餐 Prompt 构建器 ───────────────────────────
  /**
   * 为指定餐次构建单餐 AI prompt。
   * @param pkg 已预计算的完整上下文包（BMR/TDEE/库存/铁律只算一次）
   * @param mealSlot 目标餐次："早餐" | "午餐" | "晚餐"
   * @param alreadyGenerated 已生成的餐次摘要，防止食材/热量冲突
   */
  buildMealPrompt(
    pkg: ContextPackage,
    mealSlot: string,
    alreadyGenerated: Array<{ slot: string; calories: number; mainIngredients: string[] }>
  ): string {
    const { computed, pantryDigest } = pkg;

    const mealIcon: Record<string, string> = { "早餐": "🍳", "午餐": "🥗", "晚餐": "🌙", "加餐": "🍪" };

    // ── 已生成餐次上下文 ──
    let priorMealsBlock = "";
    if (alreadyGenerated.length > 0) {
      const priorSummaries = alreadyGenerated.map(m =>
        `${m.slot}: ${m.calories} kcal, 主料: ${m.mainIngredients.join("、")}`
      ).join("\n");
      const usedCals = alreadyGenerated.reduce((sum, m) => sum + m.calories, 0);
      const remainingCals = computed.targetCalories - usedCals;
      priorMealsBlock = `\n## ⚠️ 已生成的餐次（请勿重复使用以下主料，剩余热量配额 ${remainingCals} kcal）\n${priorSummaries}\n`;
    }

    const profileBlock = `## 用户档案
${pkg.profileSummary}
（以下数据已由本地引擎精确计算，请直接使用，无需重复计算）
- 基础代谢 BMR: ${computed.bmr} kcal
- 每日消耗 TDEE: ${computed.tdee} kcal
- 全日目标热量: ${computed.targetCalories} kcal
- 全日宏量素目标: 蛋白质 ${computed.macroTargets.protein_g}g | 碳水 ${computed.macroTargets.carbs_g}g | 脂肪 ${computed.macroTargets.fat_g}g`;

    const pantryBlock = `## 库存摘要
${pantryDigest.summaryText}`;

    const nutritionBlock = pkg.nutritionRefs
      ? `\n## 库存食材营养参考（每100g，已由本地数据库精确计算）\n${pkg.nutritionRefs}\n`
      : "";

    const rulesBlock = pkg.rulesText
      ? `\n### 🚨 永久铁律\n${pkg.rulesText}\n`
      : "";

    const slotMealMap: Record<string, string> = {
      "早餐": "早餐", "午餐": "午餐", "晚餐": "晚餐", "加餐": "加餐",
    };

    return `你是专业的运动和营养膳食规划 AI。请仅为 ${pkg.date} 设计 **${slotMealMap[mealSlot] || mealSlot}** 这一餐。

${rulesBlock}
${profileBlock}

${pantryBlock}
${nutritionBlock}
${priorMealsBlock}
## 🚨 铁律（违反任一条=不合格）
1. 【食材来源：只许用库存中存在的】本餐原料必须100%来自上方 📦 可用食材列表。唯一例外：基础调料（盐糖酱油醋料酒蚝油食用油胡椒粉花椒八角桂皮香叶味精鸡精淀粉香油）。禁止使用列表外的任何食材！
2. BMR/TDEE/目标热量已由本地引擎精确计算，直接使用，无需重复计算。
3. 优先消耗 ⚠️ 标记的库存偏低食材。
${alreadyGenerated.length > 0 ? "4. 【禁止与已有餐次雷同】已生成的餐次主料已列在上方，本餐请选用不同的主料，确保一日三餐多样化。" : ""}
5. 写明精确原料清单，量化到克(g)/毫升(ml)。
6. 操作步骤附带终止条件断言（如：直到筷子能轻松穿透）。

## 输出格式
你必须输出一个纯 JSON 对象（不要用 \`\`\`json 包裹）：

{
  "markdown_content": "## ${mealIcon[mealSlot] || "🍳"} ${slotMealMap[mealSlot] || mealSlot} (预计 xxx kcal)\\n- **菜品名称与难度**: ...\\n- **精确原料清单**: 食材名 数字g、食材名 数字ml...\\n- **程序化操作步骤**: 1. ... 2. ...",
  "consume": [{"name": "食材名", "amount_g": 数字（必须与库存单位一致）}]
}`;
  }
}

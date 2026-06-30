// src/models/types.ts

// ── 用户身体档案 ─────────────────────────────────────────
export type Gender = "male" | "female";

export type ActivityLevel =
  | "sedentary"      // 久坐不动
  | "light"          // 轻度活动（每周1-3天）
  | "moderate"       // 中度活动（每周3-5天）
  | "active"         // 高度活动（每周6-7天）
  | "very_active";   // 专业运动员级别

export type GoalType =
  | "fat_loss"       // 减脂
  | "muscle_gain"    // 增肌
  | "maintenance";   // 维持体重

export type DietaryStyle =
  | "balanced"       // 均衡饮食
  | "low_carb"       // 低碳水
  | "keto"           // 生酮饮食
  | "mediterranean"  // 地中海饮食
  | "high_protein";  // 高蛋白

export interface BodyMetrics {
  height_cm: number;
  weight_kg: number;
  age: number;
  gender: Gender;
  activity_level: ActivityLevel;
}

export interface WeightGoal {
  type: GoalType;
  target_weight_kg: number;
  weekly_rate_kg: number;  // 正数增重，负数减重
}

export interface DietPreferences {
  allergies: string[];
  dislikes: string[];
  dietary_style: DietaryStyle;
}

export interface UserProfile {
  updated: string;         // ISO 日期字符串 如 "2026-06-26"
  body: BodyMetrics;
  goal: WeightGoal;
  preferences: DietPreferences;
}

// ── 食材库存 ───────────────────────────────────────────────
export type PantryPriority =
  | "🔴 急需消耗"
  | "🟡 尽快消耗"
  | "🟢 充足";

export interface PantryItem {
  category: string;        // 食材类别（蛋白质/碳水/蔬菜/脂肪/...）
  name: string;            // 食材名称
  quantity: string;        // 当前数量/克重（如 "600g"、"12枚"）
  purchaseDate: string;    // 采购日期
  expiryDate: string;      // 保质期至
  priority: PantryPriority; // 优先级预警
}

// ── AI 输出结构 ───────────────────────────────────────────
export interface ConsumeItem {
  name: string;
  amount_g: number;
}

export interface AgyResponse {
  markdownContent: string;          // 完整的 Markdown 菜单正文
  consume: ConsumeItem[];           // 库存扣减列表
  shopping_advice: string[];        // 采购建议
}

// ── v4.2 单餐独立生成 ──────────────────────────────────────
/** AI 单餐响应（替代 AgyResponse 用于分餐生成） */
export interface SingleMealResponse {
  markdownContent: string;          // 单餐 Markdown 正文
  consume: ConsumeItem[];           // 该餐消耗的食材列表
}

// ── v4.2 看板餐次文件元信息 ────────────────────────────────
/** 看板渲染使用的餐次文件描述符 */
export interface MealFileInfo {
  label: string;                    // 餐次标签："早餐" | "午餐" | "晚餐" | "加餐"
  filePath: string;                 // vault 相对路径，如 "Diet/Meal_Plans/2026-06-29/breakfast.md"
  isGenerated: boolean;             // 单餐文件是否已存在
  isReplaced: boolean;              // 是否已被用户自选食谱替换
  replacement?: MealReplacement;    // 替换的食谱元数据
}

// ── v4.2 增强版单餐文件 frontmatter ─────────────────────────
/** 单餐 Markdown 文件的 frontmatter 结构 */
export interface MealFrontmatter {
  type: "meal";
  meal_slot: string;                // "早餐" | "午餐" | "晚餐" | "加餐"
  date: string;                     // ISO 日期 "2026-06-29"
  calories: number;
  protein_g: number;
  carbs_g: number;
  fat_g: number;
  image: string;                    // 成品图 URL（AI 生成的为空）
  description: string;              // 一句话简介（AI 生成的为空）
  tips: string[];                   // 小贴士（AI 生成的为空）
  source: string;                   // 来源："pantryfin" 或网页 URL
}

// ── v4.2 日索引文件 frontmatter ────────────────────────────
/** 日索引文件的 frontmatter 结构 */
export interface DailyIndexFrontmatter {
  type: "meal-plan";
  date: string;
  target_calories: number;
  protein_g: number;
  carbs_g: number;
  fat_g: number;
  generated_slots: string[];        // 已生成哪些餐次，如 ["早餐", "午餐"]
}

// ── 营养指标（用于 Dashboard 展示）─────────────────────────
export interface NutritionTargets {
  bmr: number;              // 基础代谢率 (kcal)
  tdee: number;             // 目标热量 (kcal)
  protein_g: number;
  carbs_g: number;
  fat_g: number;
}

// ── AI 聊天采访流 (Onboarding Chat Interviewer) ────────────────
export interface ChatMessage {
  id: string;
  sender: "user" | "ai";
  text: string;
  timestamp: number;
}

export interface OnboardingInterviewReply {
  nextQuestion: string;            // AI 的下一句聊天回复
  isCompleted: boolean;            // 是否已收集齐全
  profileData?: UserProfile;       // 若收集齐全，生成的完整档案
}

// ── 健全月度记忆系统与管家结构化交互定义 ────────────────
export interface MemoryLogEntry {
  date: string;
  summary: string;
}

export interface DailyAgentButlerResponse {
  reply: string;
  add_items?: PantryItem[];
  consume_items?: ConsumeItem[];
  update_profile?: Record<string, any>;
  trigger_plan?: boolean;
}

// ── 放纵日自选餐系统 ────────────────────────────────
export type MealSlot = "早餐" | "午餐" | "晚餐" | "加餐";
export const MEAL_SLOTS: MealSlot[] = ["早餐", "午餐", "晚餐", "加餐"];

export interface ParsedRecipe {
  id: string;               // "aquatic/红烧鲤鱼"
  name: string;
  category: string;          // "aquatic"
  categoryLabel: string;     // "水产海鲜"
  difficulty: number;        // 1-5
  caloriesPerServe: number;  // 从"预估卡路里"解析
  ingredients: { name: string; amountGrams: number; isCore: boolean }[];
  stepsPreview: string;
}

// 餐次替换条目（替代 AI 输出的某餐）
export interface MealReplacement {
  recipeId: string;
  recipeName: string;
  baseCalories: number;
  servings?: number;                           // 份量 (默认 1，支持 0.5/1/2/3)
  actualQuantities?: Record<string, number>;  // 用户调整的实际用量(g)
  adjustedCalories?: number;                   // 内置计算器重算后热量
  isAccepted: boolean;
  preorderDate?: string;                       // 预定的日期（如"2026-06-29"）
}

// 单日替换映射: { "2026-06-28": { "早餐": {...}, "午餐": {...} } }
export type MealReplacements = Record<string, Partial<Record<MealSlot, MealReplacement>>>;

// 保留兼容旧字段
export interface CheatDayEntry extends MealReplacement {}
export interface CheatDaySelection {
  date: string;
  meals: Partial<Record<MealSlot, CheatDayEntry>>;
  lastModified: number;
}


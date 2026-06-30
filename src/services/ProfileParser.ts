// src/services/ProfileParser.ts

import { App, TFile, Notice } from "obsidian";
import { UserProfile, BodyMetrics, WeightGoal, DietPreferences } from "../models/types";

export class ProfileParser {
  private app: App;

  constructor(app: App) {
    this.app = app;
  }

  /**
   * 从 Vault 中读取并解析 Profile.md 的 YAML Frontmatter。
   * 使用 Obsidian 的 metadataCache（内存缓存），性能极高。
   *
   * @param profilePath - Profile.md 在 Vault 中的相对路径
   * @returns 解析后的 UserProfile 对象，若文件不存在或格式错误则返回 null
   */
  async readProfile(profilePath: string): Promise<UserProfile | null> {
    // 1. 获取文件引用
    const file = this.app.vault.getAbstractFileByPath(profilePath);
    if (!(file instanceof TFile)) {
      return null;  // 静默返回，由调用方决定如何引导用户
    }

    // 2. 从 metadataCache 读取前置元数据（高性能，不触发磁盘 IO）
    let fm = this.app.metadataCache.getFileCache(file)?.frontmatter;

    // 兜底机制：若 metadataCache 异步索引尚未更新（如建档刚创建完文件立即读取），直接强读磁盘内容同步解析 YAML
    if (!fm) {
      try {
        const rawText = await this.app.vault.read(file);
        const yamlMatch = rawText.match(/^---\r?\n([\s\S]*?)\r?\n---/);
        if (yamlMatch && yamlMatch[1]) {
          // 简单的自定义解析或借助 js-yaml 逻辑提取键值对
          const lines = yamlMatch[1].split("\n");
          const fmObj: any = { body: {}, goal: {}, preferences: {} };
          let currSection = "";
          for (const l of lines) {
            const trimmed = l.trim();
            if (!trimmed || trimmed.startsWith("#")) continue;
            if (trimmed === "body:" || trimmed === "goal:" || trimmed === "preferences:") {
              currSection = trimmed.slice(0, -1);
              continue;
            }
            const colonIdx = trimmed.indexOf(":");
            if (colonIdx > 0) {
              const k = trimmed.slice(0, colonIdx).trim();
              let v: any = trimmed.slice(colonIdx + 1).trim();
              if (v.startsWith("[") && v.endsWith("]")) {
                try { v = JSON.parse(v); } catch { v = []; }
              } else if (!isNaN(Number(v))) {
                v = Number(v);
              }
              if (currSection && fmObj[currSection]) {
                fmObj[currSection][k] = v;
              } else {
                fmObj[k] = v;
              }
            }
          }
          // 兼容嵌套格式 (body 有数据) 和扁平格式 (顶层有 height_cm)
          if (Object.keys(fmObj.body).length > 0 || fmObj.height_cm !== undefined) fm = fmObj;
        }
      } catch (e) {
        console.warn("直接磁盘解析 YAML 失败:", e);
      }
    }

    if (!fm) {
      new Notice("⚠️ PantryFin: Profile.md 缺少 YAML Frontmatter");
      return null;
    }

    // 3. 格式兼容：嵌套格式 (body/goal/preferences) 或扁平格式 (height_cm 等顶层键)
    const resolved = this._normalizeProfileFM(fm);

    // 4. 安全提取并校验各字段
    try {
      const profile: UserProfile = {
        updated: resolved.updated ?? new Date().toISOString().split("T")[0],
        body: this.parseBody(resolved.body),
        goal: this.parseGoal(resolved.goal),
        preferences: this.parsePreferences(resolved.preferences),
      };
      return profile;
    } catch (err) {
      new Notice(`❌ PantryFin: Profile 解析错误 - ${(err as Error).message}`);
      console.error("PantryFin ProfileParser error:", err);
      return null;
    }
  }

  /**
   * 安全地更新 Profile.md 中的某个字段。
   * 使用 Obsidian 官方推荐的 processFrontMatter，避免竞态条件。
   */
  async updateField(
    profilePath: string,
    key: string,
    value: unknown
  ): Promise<void> {
    const file = this.app.vault.getAbstractFileByPath(profilePath);
    if (!(file instanceof TFile)) return;

    await this.app.fileManager.processFrontMatter(file, (frontmatter) => {
      // 支持嵌套路径，如 "body.weight_kg"
      const keys = key.split(".");
      let target = frontmatter as Record<string, unknown>;

      for (let i = 0; i < keys.length - 1; i++) {
        const k = keys[i]!;
        if (typeof target[k] !== "object" || target[k] === null) {
          target[k] = {};
        }
        target = target[k] as Record<string, unknown>;
      }

      target[keys[keys.length - 1]!] = value;
    });
  }

  // ── 格式兼容层 ────────────────────────────────────────
  /** 将扁平格式 {height_cm, goal_type, ...} 和嵌套格式 {body:{...}, goal:{...}} 统一转为嵌套格式 */
  private _normalizeProfileFM(fm: Record<string, any>): Record<string, any> {
    // 已经是嵌套格式
    if (fm.body && typeof fm.body === "object") return fm;

    // 扁平格式：将顶层键映射到嵌套结构
    return {
      updated: fm.updated,
      body: {
        height_cm:      fm.height_cm,
        weight_kg:      fm.weight_kg,
        age:            fm.age,
        gender:         fm.gender,
        activity_level: fm.activity_level,
      },
      goal: {
        type:             fm.goal_type,
        target_weight_kg: fm.target_weight_kg,
        weekly_rate_kg:   fm.weekly_rate_kg,
      },
      preferences: {
        allergies:     fm.allergies ?? [],
        dislikes:      fm.dislikes ?? [],
        dietary_style: fm.dietary_style ?? "balanced",
      },
    };
  }

  // ── 私有校验方法 ───────────────────────────────────────
  private parseBody(raw: unknown): BodyMetrics {
    if (!raw || typeof raw !== "object") {
      throw new Error("body 字段缺失或格式错误");
    }
    const r = raw as Record<string, unknown>;
    return {
      height_cm:      this.requireNumber(r, "height_cm"),
      weight_kg:      this.requireNumber(r, "weight_kg"),
      age:            this.requireNumber(r, "age"),
      gender:         this.requireEnum(r, "gender", ["male", "female"]),
      activity_level: this.requireEnum(r, "activity_level", [
        "sedentary", "light", "moderate", "active", "very_active",
      ]),
    };
  }

  private parseGoal(raw: unknown): WeightGoal {
    if (!raw || typeof raw !== "object") {
      throw new Error("goal 字段缺失或格式错误");
    }
    const r = raw as Record<string, unknown>;
    return {
      type:             this.requireEnum(r, "type", [
        "fat_loss", "muscle_gain", "maintenance",
      ]),
      target_weight_kg: this.requireNumber(r, "target_weight_kg"),
      weekly_rate_kg:   this.requireNumber(r, "weekly_rate_kg"),
    };
  }

  private parsePreferences(raw: unknown): DietPreferences {
    if (!raw || typeof raw !== "object") {
      // preferences 可选，返回默认值
      return { allergies: [], dislikes: [], dietary_style: "balanced" };
    }
    const r = raw as Record<string, unknown>;
    return {
      allergies:     Array.isArray(r.allergies) ? r.allergies.map(String) : [],
      dislikes:      Array.isArray(r.dislikes)  ? r.dislikes.map(String)  : [],
      dietary_style: this.requireEnum(r, "dietary_style", [
        "balanced", "low_carb", "keto", "mediterranean", "high_protein",
      ]),
    };
  }

  // ── 通用校验工具 ───────────────────────────────────────
  private requireNumber(obj: Record<string, unknown>, key: string): number {
    const val = obj[key];
    if (typeof val !== "number" || isNaN(val)) {
      throw new Error(`字段 "${key}" 必须是有效数字，当前值: ${String(val)}`);
    }
    return val;
  }

  private requireEnum<T extends string>(
    obj: Record<string, unknown>,
    key: string,
    allowed: T[]
  ): T {
    const val = obj[key];
    if (!allowed.includes(val as T)) {
      throw new Error(
        `字段 "${key}" 值 "${String(val)}" 无效，允许值: ${allowed.join(", ")}`
      );
    }
    return val as T;
  }
}

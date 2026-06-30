export interface IndexMealLink {
  label: string;
  filePath: string; // vault 相对路径，例如 "2026-06-29/breakfast"
  calories: number;
}

export interface ParsedMealContent {
  calories: number;
  ingredients: string;
  description: string;
  image: string;
  tips: string[];
}

export class MealPlanParser {
  /**
   * 从日索引 Markdown 正文中解析所有餐次链接
   */
  public static parseIndexMeals(indexContent: string): IndexMealLink[] {
    const meals: IndexMealLink[] = [];
    const MEAL_SLOTS = ["早餐", "午餐", "晚餐", "加餐", "早午餐", "夜宵"];
    const SLOT_FILENAME_MAP: Record<string, string> = {
      "早餐": "breakfast", "午餐": "lunch", "晚餐": "dinner", "加餐": "snack", "早午餐": "brunch", "夜宵": "supper"
    };

    // 尝试从 frontmatter 解析日期作为兜底
    const dateMatch = indexContent.match(/^date:\s*([0-9]{4}-[0-9]{2}-[0-9]{2})/m);
    const dateStr = dateMatch ? dateMatch[1] : "";

    const lines = indexContent.split("\n");
    for (const line of lines) {
      let foundLabel: string | null = null;
      let targetPath: string = "";

      // 1. 匹配 [[path|label]] 或 [[path]]
      const wikiMatch = line.match(/\[\[([^\]]+?)(?:\|([^\]]+?))?\]\]/);
      if (wikiMatch) {
        const pathPart = wikiMatch[1]!.trim();
        const labelPart = wikiMatch[2]?.trim();
        if (labelPart && MEAL_SLOTS.includes(labelPart)) {
          foundLabel = labelPart;
          targetPath = pathPart;
        } else {
          for (const slot of MEAL_SLOTS) {
            if (pathPart.endsWith(SLOT_FILENAME_MAP[slot]!) || line.includes(slot)) {
              foundLabel = slot;
              targetPath = pathPart;
              break;
            }
          }
        }
      } else {
        // 2. 匹配 Markdown 链接 [label](path)
        const mdMatch = line.match(/\[([^\]]+?)\]\(([^)]+?)\)/);
        if (mdMatch) {
          const labelPart = mdMatch[1]!.trim();
          const pathPart = mdMatch[2]!.trim().replace(/\.md$/, "");
          if (MEAL_SLOTS.includes(labelPart)) {
            foundLabel = labelPart;
            targetPath = pathPart;
          }
        }
      }

      // 3. 回退：如果行内带有二级/三级标题和餐次名，但没匹配到合法链接
      if (!foundLabel && /^#{2,4}\s/.test(line)) {
        for (const slot of MEAL_SLOTS) {
          if (line.includes(slot)) {
            foundLabel = slot;
            if (dateStr) {
              targetPath = `${dateStr}/${SLOT_FILENAME_MAP[slot] || slot}`;
            }
            break;
          }
        }
      }

      if (foundLabel && targetPath) {
        if (meals.some(m => m.label === foundLabel)) continue;
        const calMatch = line.match(/\(?(\d+)\s*(?:kcal|千卡|大卡|卡)\)?/i);
        const calories = calMatch ? parseInt(calMatch[1]!, 10) : 0;
        meals.push({ label: foundLabel, filePath: targetPath, calories });
      }
    }

    return meals;
  }

  /**
   * 5 层级单餐文件深度聚合器
   */
  public static parseMealContent(content: string, defaultCalories = 0): ParsedMealContent {
    let calories = defaultCalories;
    let image = "";
    let ingredients = "";
    let description = "";
    const tips: string[] = [];

    // ── 层级 1: Frontmatter 快取 ──
    const calMatch = content.match(/^calories:\s*(\d+)/m);
    if (calMatch) calories = parseInt(calMatch[1]!, 10);

    const imgMatch = content.match(/^image:\s*"?([^"\n]+)"?/m);
    if (imgMatch && imgMatch[1]!.trim()) image = imgMatch[1]!.trim();

    // ── 层级 2: Markdown 表格精确扫描 ──
    const ingTableMatch = content.match(/##\s*🥩\s*食材清单[\s\S]*?(?=\n##\s|$)/);
    if (ingTableMatch) {
      const ingLines = ingTableMatch[0]
        .split("\n")
        .filter(l => l.includes("|") && l.includes("**"))
        .map(l => {
          const cells = l.split("|").map(c => c.trim()).filter(Boolean);
          const name = (cells[0] || "").replace(/\*\*/g, "");
          const qty = cells[1] || "";
          return name ? `${name} ${qty}` : "";
        })
        .filter(Boolean);
      if (ingLines.length > 0) ingredients = ingLines.join(", ");
    }

    // ── 层级 3: 标题区域或多级缩进列表聚合 ──
    if (!ingredients) {
      const ingHeaderMatch = content.match(/##\s*(?:🥩\s*)?(?:食材|原料|用料|配料|准备原料|精确食材)(?:清单)?[\s\S]*?(?=\n##\s|$)/);
      if (ingHeaderMatch) {
        const lines = ingHeaderMatch[0].split("\n").slice(1);
        const collected: string[] = [];
        for (const line of lines) {
          const trimmed = line.trim();
          if (/^[-*•]\s*\S+/.test(trimmed)) {
            if (/^[-*•]\s*(?:主料|辅料|配料|调料|其他|准备|原料|食材|用料)\s*[：:]?$/.test(trimmed) || trimmed.endsWith(":") || trimmed.endsWith("：")) {
              continue;
            }
            const clean = trimmed.replace(/^[-*•]\s*/, "").replace(/\*\*/g, "").trim();
            if (clean) collected.push(clean);
          }
        }
        if (collected.length > 0) ingredients = collected.join("、");
      }
    }

    if (!ingredients) {
      const lines = content.split("\n");
      let inIngSection = false;
      const subIngs: string[] = [];
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i]!;
        if (/[-*•]\s*(?:\*\*)?(?:精确)?(?:原料|食材|用料|配料|准备原料|精确食材)(?:清单)?(?:\*\*)?\s*[：:]/.test(line)) {
          inIngSection = true;
          const inlineText = line.replace(/.*[：:]\s*/, "").trim();
          if (inlineText.length > 1) {
            ingredients = inlineText;
            break;
          }
          continue;
        }
        if (inIngSection) {
          if (/^\s{2,}[-*•]\s*(.+)/.test(line) || /^\t+[-*•]\s*(.+)/.test(line)) {
            const match = line.match(/^\s+[-*•]\s*(.+)/);
            if (match && match[1]!.trim()) {
              subIngs.push(match[1]!.trim().replace(/\*\*/g, ""));
            }
          } else if (line.trim() !== "" && !/^\s/.test(line)) {
            break;
          }
        }
      }
      if (subIngs.length > 0) ingredients = subIngs.join("、");
    }

    // ── 层级 4: 正则数字克重匹配 (兜底识别纯数字g行或带单位列表) ──
    if (!ingredients) {
      const plainIngs = [...content.matchAll(/([一-龥]{1,10})\s*(\d+(?:\.\d+)?)\s*(g|ml|克|毫升|个|勺|片|袋|杯|两|斤)/gi)]
        .map(m => `${m[1]!.trim()} ${m[2]}${m[3]}`);
      if (plainIngs.length > 0) {
        ingredients = plainIngs.join("、");
      } else {
        const listLines = content.split("\n")
          .filter(l => /^[-*•]\s*\S+/.test(l.trim()) && /\d+\s*(?:g|ml|克|毫升|个|勺|片|两|斤)/i.test(l));
        if (listLines.length > 0) {
          ingredients = listLines.map(l => l.replace(/^[-*•]\s*/, "").trim().replace(/\*\*/g, "")).join("、");
        }
      }
    }

    // ── 做法提取 (强化步骤正则增强兼容) ──
    const stepsMatch = content.match(/(?:[-*•]\s*(?:\*\*)?(?:程序化操作步骤|烹饪步骤|做法|操作步骤)(?:\*\*)?\s*[：:]|##\s*(?:👨‍🍳\s*烹饪步骤|🍳\s*烹饪步骤))[\s\S]*?(?=\n##\s|\n[-*•]\s*\*\*[^\d]|$)/);
    if (stepsMatch) {
      const stepLines = stepsMatch[0]
        .split("\n")
        .filter(l => /(?:\d+[\.\)、]|第[一二三四五六七八九十\d]+步)\s*.+/g.test(l.trim()))
        .map(l => l.trim().replace(/^[-*•]\s*/, ""));
      if (stepLines.length > 0) {
        description = stepLines.join("\n");
      }
    }
    if (!description) {
      const globalStepLines = content.split("\n")
        .filter(l => /(?:^\s*(?:\*\*)?\d+(?:\*\*)?[\.\)、]|^\s*第[一二三四五六七八九十\d]+步)\s*\S+/g.test(l))
        .map(l => l.trim().replace(/^[-*•]\s*/, ""));
      if (globalStepLines.length > 0) {
        description = globalStepLines.join("\n");
      }
    }

    return { calories, ingredients, description, image, tips };
  }
}

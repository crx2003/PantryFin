import { Notice, TFile, normalizePath } from "obsidian";
import { BaseCard } from "./BaseCard";
import { MealPlanWriter } from "../../services/MealPlanWriter";
import { MealPlanParser } from "../../services/MealPlanParser";
import { RecipePickerModal } from "../RecipePickerModal";
import { getFoodDatabase } from "../../nutrition/FoodDatabase";

type MealSlot = "早餐" | "午餐" | "晚餐" | "加餐" | "早午餐" | "夜宵";

/** v4.2 餐次文件元信息（运行时填充） */
interface MealRuntimeInfo {
  label: string;
  filePath: string;           // vault 中单餐文件的完整相对路径
  calories: number;
  ingredients: string;        // 用料摘要文本
  description: string;        // 步骤描述（仅旧格式使用）
  isReplaced: boolean;
  mealFile: TFile | null;     // 单餐文件引用
}

export class DietGuideCard extends BaseCard {
  private _mealActionBusy = false;
  private _mealRuntimeInfos: MealRuntimeInfo[] = [];  // v4.2 运行时餐次文件信息
  private _displayDate: string = "";

  async render(): Promise<void> {
    const actualToday = this.context.todayKey();
    let today = actualToday;

    const folder = this.context.settings.mealPlanFolder || "Diet/Meal_Plans";
    let filePath = normalizePath(`${folder}/${MealPlanWriter.datePath(today)}.md`);
    let file = this.context.app.vault.getAbstractFileByPath(filePath);
    let meals: Array<{ label: string; description: string; calories: number; ingredients: string }> = [];
    let hasRealPlan = false;
    let planContent = "";
    let isNewFormat = false;  // v4.2 一餐一文件格式标记
    this._mealRuntimeInfos = [];  // 重置供 _openMealFile 使用

    if (file && file instanceof TFile) {
      planContent = await this.context.app.vault.read(file);
    } else if (await this.context.app.vault.adapter.exists(filePath)) {
      try {
        planContent = await this.context.app.vault.adapter.read(filePath);
      } catch (e) {
        console.warn("[PantryFin] 适配器读取日索引失败:", e);
      }
    }

    // ── 智能就近回退加载 (Fallback Loader) ──
    if (!planContent) {
      const fallbackDays = this.context.settings.fallbackDays ?? 3;
      const currDate = new Date();
      for (let i = 1; i <= fallbackDays; i++) {
        const d = new Date(currDate);
        d.setDate(d.getDate() - i);
        const dStr = this.context.todayKey(d);
        const dPath = normalizePath(`${folder}/${MealPlanWriter.datePath(dStr)}.md`);
        const dFile = this.context.app.vault.getAbstractFileByPath(dPath);
        let dContent = "";
        if (dFile && dFile instanceof TFile) {
          dContent = await this.context.app.vault.read(dFile);
        } else if (await this.context.app.vault.adapter.exists(dPath)) {
          try { dContent = await this.context.app.vault.adapter.read(dPath); } catch (e) {}
        }
        if (dContent) {
          today = dStr;
          filePath = dPath;
          file = dFile;
          planContent = dContent;
          console.log(`[PantryFin] 今日计划不存在，自动就近回退展示: ${today}`);
          break;
        }
      }
    }

    this._displayDate = today;
    const acceptedTicks = this.context.settings.acceptedMealTicks?.[today] || [];
    const mealReplacements = this.context.settings.mealReplacements?.[today] || {};

    if (planContent) {
      // 检测是否为新版日索引格式（frontmatter 含 generated_slots）
      isNewFormat = /generated_slots:/.test(planContent);

      if (isNewFormat) {
        // 从日索引解析 wiki 链接
        const indexMeals = this.extractMealsFromIndex(planContent);
        console.log(`[PantryFin] 新格式日索引检测: ${indexMeals.length} 餐`, indexMeals);

        if (indexMeals.length > 0) {
          const MEAL_SLOT_LIST = ["早餐", "午餐", "晚餐", "加餐"];

          for (const slot of MEAL_SLOT_LIST) {
            const repl = mealReplacements[slot];
            const idxMeal = indexMeals.find(m => m.label === slot);

            if (idxMeal) {
              const cleanPath = idxMeal.filePath.replace(/\.md$/, "");
              const fullMealPath = normalizePath(`${folder}/${cleanPath}.md`);
              const mealFile = this.context.app.vault.getAbstractFileByPath(fullMealPath);
              let ingredients = "";
              let description = "";
              let mealContent = "";

              if (mealFile instanceof TFile) {
                try {
                  mealContent = await this.context.app.vault.read(mealFile);
                } catch (e) {
                  console.warn(`[PantryFin] 读取${slot}文件失败:`, e);
                }
              } else if (await this.context.app.vault.adapter.exists(fullMealPath)) {
                try {
                  mealContent = await this.context.app.vault.adapter.read(fullMealPath);
                } catch (e) {
                  console.warn(`[PantryFin] 适配器读取${slot}文件失败:`, e);
                }
              } else {
                console.warn(`[PantryFin] ${slot}单餐文件不存在: ${fullMealPath}`);
              }

              if (mealContent) {
                const parsed = MealPlanParser.parseMealContent(mealContent, idxMeal.calories);
                ingredients = parsed.ingredients;
                description = parsed.description;
              }

              meals.push({
                label: slot,
                description: repl ? `【放纵日自选】${repl.recipeName}` : description,
                calories: repl ? (repl.adjustedCalories ?? repl.baseCalories ?? idxMeal.calories) : idxMeal.calories,
                ingredients: repl ? `📋 ${repl.recipeName} (${repl.adjustedCalories ?? repl.baseCalories}kcal)` : ingredients,
              });
              this._mealRuntimeInfos.push({
                label: slot,
                filePath: fullMealPath,
                calories: idxMeal.calories,
                ingredients,
                description,
                isReplaced: !!repl,
                mealFile: mealFile instanceof TFile ? mealFile : null,
              });
            } else if (repl) {
              meals.push({
                label: slot,
                description: `【放纵日自选】${repl.recipeName}`,
                calories: repl.adjustedCalories ?? repl.baseCalories ?? 0,
                ingredients: `📋 ${repl.recipeName} (${repl.adjustedCalories ?? repl.baseCalories}kcal)`,
              });
              this._mealRuntimeInfos.push({
                label: slot, filePath: "", calories: repl.baseCalories ?? 0,
                ingredients: "", description: "", isReplaced: true, mealFile: null,
              });
            }
          }
          hasRealPlan = meals.length > 0;
        }

        // 回退：新格式解析结果为空 → 降级用旧格式
        if (!hasRealPlan) {
          console.warn("[PantryFin] 新格式解析无结果，回退旧格式");
          isNewFormat = false;
          meals = this.extractMeals(planContent);
          hasRealPlan = meals.length > 0;
        }
      } else {
        // 旧格式：使用原有正则切分
        meals = this.extractMeals(planContent);
        hasRealPlan = meals.length > 0;
      }
    }

    const isFallback = today !== actualToday;
    const cardTitle = isFallback
      ? `🍽️ 饮食计划 (📅 展示历史: ${today})`
      : (hasRealPlan ? "🍽️ 今日饮食菜谱与餐后打卡中心" : "🍽️ 今日饮食安排");
    const card = this.createCard("study", cardTitle, hasRealPlan ? "🔄 重新生成" : "");

    if (hasRealPlan) {
      if (isFallback) {
        const noticeBar = card.createDiv({
          attr: {
            style: "background: rgba(255, 170, 0, 0.15); border-left: 4px solid #ffaa00; padding: 8px 12px; margin-bottom: 12px; border-radius: 6px; font-size: 13px; color: var(--text-normal); display: flex; justify-content: space-between; align-items: center;"
          }
        });
        noticeBar.createSpan({ text: `📅 今日 (${actualToday}) 暂无计划，正为您展示最近一份计划 (${today})` });
        const genTodayBtn = noticeBar.createEl("button", { text: "立即生成今日食谱", attr: { style: "padding: 4px 10px; font-size: 12px; cursor: pointer; border-radius: 4px; border: 1px solid #ffaa00; background: transparent; color: #ffaa00; font-weight: 600;" } });
        genTodayBtn.addEventListener("click", async () => {
          genTodayBtn.disabled = true;
          genTodayBtn.textContent = "⏳ 生成中...";
          await this.context.generateDailyPlan(actualToday);
          this.context.scheduleRender();
        });
      }

      const headerEl = card.querySelector(".museum-live-card-header button");
      if (headerEl) {
        headerEl.addEventListener("click", async () => {
          (headerEl as HTMLButtonElement).disabled = true;
          (headerEl as HTMLButtonElement).textContent = "⏳ 生成中...";
          await this.context.generateDailyPlan(today);
          this.context.scheduleRender();
        });
      }
    }

    const hasAnyReplacement = Object.keys(mealReplacements).length > 0;

    if (!hasRealPlan && !hasAnyReplacement) {
      const emptyBox = card.createDiv({ attr: { style: "text-align: center; padding: 24px 16px;" } });
      emptyBox.createEl("div", { text: "📋", attr: { style: "font-size: 42px; margin-bottom: 12px;" } });
      emptyBox.createEl("p", { text: `尚未生成 ${today} 的饮食计划`, attr: { style: "font-weight: 600; color: var(--text-normal); font-size: 15px; margin-bottom: 6px;" } });
      emptyBox.createEl("p", { text: "点击下方按钮，AI 将根据您的身体数据和库存食材，自动设计一日三餐", attr: { style: "color: var(--nd-text-soft); font-size: 12px; margin-bottom: 8px;" } });
      const genBtn = emptyBox.createEl("button", { text: "✨ AI 智能推演今日食谱", cls: "nutri-add-stock-btn", attr: { style: "padding: 10px 24px !important; font-size: 14px !important;" } });
      genBtn.addEventListener("click", async () => { genBtn.disabled = true; genBtn.textContent = "🤖 AI 正在推演计算中..."; await this.context.generateDailyPlan(); this.context.scheduleRender(); });
      const cheatEntry = emptyBox.createEl("button", { text: "🎉 今日放纵（自选菜谱）", attr: { style: "margin-top:8px;padding:6px 14px;border:1px solid var(--nd-accent);border-radius:8px;background:var(--nd-card-bg);color:var(--nd-accent);cursor:pointer;font-weight:600;" } });
      cheatEntry.addEventListener("click", () => { new RecipePickerModal(this.context.app, this.context.plugin as any, today).open(); });
      return;
    }

    const aiCalMap: Partial<Record<string, number>> = {};
    for (const m of meals) aiCalMap[m.label] = m.calories || 0;

    let actualTotalCals = 0;
    for (const slot of ["早餐", "午餐", "晚餐", "加餐"] as MealSlot[]) {
      const repl = mealReplacements[slot];
      if (repl) {
        actualTotalCals += repl.adjustedCalories ?? repl.baseCalories ?? 0;
      } else {
        actualTotalCals += aiCalMap[slot] || 0;
      }
    }

    // 目标热量: v4.2 frontmatter → cachedTargetCal → 回退
    const fmTargetMatch = planContent.match(/^target_calories:\s*(\d+)/m);
    const targetCals = fmTargetMatch
      ? parseInt(fmTargetMatch[1]!, 10)
      : (this.context.cachedTargetCal || 2000);

    // 宏量素: v4.2 frontmatter → body 正则 → 0
    const fmProteinMatch = planContent.match(/^protein_g:\s*(\d+)/m);
    const fmCarbsMatch = planContent.match(/^carbs_g:\s*(\d+)/m);
    const fmFatMatch = planContent.match(/^fat_g:\s*(\d+)/m);
    let proteinTarget = 0, carbsTarget = 0, fatTarget = 0;
    if (fmProteinMatch && fmCarbsMatch && fmFatMatch) {
      proteinTarget = parseInt(fmProteinMatch[1]!, 10);
      carbsTarget = parseInt(fmCarbsMatch[1]!, 10);
      fatTarget = parseInt(fmFatMatch[1]!, 10);
    } else {
      const macroMatch = planContent.match(/蛋白质\s*(\d+)\s*g.*?碳水\s*(\d+)\s*g.*?脂肪\s*(\d+)\s*g/) || planContent.match(/(\d+)\s*g\s*蛋白质.*?(\d+)\s*g\s*碳水.*?(\d+)\s*g\s*脂肪/);
      if (macroMatch) {
        proteinTarget = parseInt(macroMatch[1]!);
        carbsTarget = parseInt(macroMatch[2]!);
        fatTarget = parseInt(macroMatch[3]!);
      }
    }

    const tagsRow = card.createDiv({ attr: { style: "display: flex; flex-wrap: wrap; align-items: center; gap: 8px; margin-top: 8px; margin-bottom: 4px;" } });
    const actualRatio = targetCals > 0 ? actualTotalCals / targetCals : 0;
    const actualColor = actualRatio > 1.0 ? "#dc2626" : actualRatio > 0.8 ? "#f59e0b" : "var(--nd-accent)";
    const createTag = (text: string, bg: string, styleExtra = "") => {
      const s = tagsRow.createEl("span", { text });
      s.setAttribute("style", `font-size: 12px; font-weight: 800; color: #fff; background: ${bg}; padding: 4px 10px; border-radius: 6px; ${styleExtra}`);
    };
    createTag(`🎯 目标热量 ${targetCals} kcal`, "var(--nd-accent)", "box-shadow: 0 2px 6px rgba(16,185,129,0.25);");
    createTag(`🔥 实际热量 ${actualTotalCals} kcal (${Math.round(actualRatio * 100)}%)`, actualColor);
    if (proteinTarget > 0) {
      createTag(`🥩 蛋白质 ${proteinTarget}g`, "#e07b39", "font-size:11px;");
      createTag(`🍚 碳水 ${carbsTarget}g`, "#e4b539", "font-size:11px;");
      createTag(`🧈 脂肪 ${fatTarget}g`, "#6b9fd4", "font-size:11px;");
    }
    const mealsCount = meals.length + Object.keys(mealReplacements).filter(k => !aiCalMap[k]).length;
    const countTag = tagsRow.createEl("span", { text: `🥗 ${mealsCount} 餐` });
    countTag.setAttribute("style", "font-size: 12px; font-weight: 700; color: var(--text-normal); background: var(--nd-card-bg); border: 1px solid var(--nd-card-border); padding: 3px 10px; border-radius: 6px;");

    // v4.2: 所有餐次默认全部展开，用户可独立折叠
    const mealColors: Record<string, string> = { "早餐": "#e48962", "午餐": "#95cd81", "晚餐": "#91b0df", "加餐": "#d8a1ce", "早午餐": "#e4d277", "夜宵": "#79ced6" };
    const mealIcon: Record<string, string> = { "早餐": "🌅", "午餐": "☀️", "晚餐": "🌙", "加餐": "🍪", "早午餐": "🥐", "夜宵": "🌃" };

    const accordion = card.createDiv({ attr: { style: "display:flex;flex-direction:column;gap:4px;margin-top:6px;" } });

    const toggleMeal = (label: string) => {
      // v4.2: 独立切换，不影响其他餐次的展开状态
      const boxes = accordion.querySelectorAll<HTMLElement>(".nd-meal-box");
      boxes.forEach(b => {
        if (b.dataset.meal !== label) return;
        const body = b.querySelector<HTMLElement>(".nd-meal-body");
        if (!body) return;
        const isVisible = body.style.display === "block";
        body.style.display = isVisible ? "none" : "block";
      });
    };

    let rulesText = "";
    try { rulesText = await (this.context.plugin as any).ruleManager?.getRules?.() || ""; } catch {}

    const aiLabels = new Set(meals.map(m => m.label));
    for (const slot of ["早餐","午餐","晚餐","加餐"] as MealSlot[]) {
      const repl = mealReplacements[slot];
      if (!repl) continue;
      if (aiLabels.has(slot)) {
        const aiMeal = meals.find(m => m.label === slot)!;
        aiMeal.calories = repl.adjustedCalories ?? repl.baseCalories ?? aiMeal.calories;
        aiMeal.description = `【放纵日自选】${repl.recipeName}`;
        aiMeal.ingredients = `📋 ${repl.recipeName} (${repl.adjustedCalories ?? repl.baseCalories}kcal)`;
      } else {
        meals.push({
          label: slot,
          description: `【放纵日自选】${repl.recipeName}`,
          calories: repl.adjustedCalories ?? repl.baseCalories ?? 0,
          ingredients: `📋 ${repl.recipeName} (${repl.adjustedCalories ?? repl.baseCalories}kcal)`,
        });
      }
    }

    for (const meal of meals) {
      const box = accordion.createDiv({
        cls: "nd-meal-box",
        attr: {
          "data-meal": meal.label,
          style: "border:1px solid var(--nd-card-border);border-radius:8px;overflow:hidden;"
        }
      });

      const header = box.createDiv({
        attr: { style: "display:flex;align-items:center;justify-content:space-between;padding:8px 10px;cursor:pointer;user-select:none;background:var(--nd-panel-bg);" }
      });
      header.addEventListener("click", () => {
        toggleMeal(meal.label);
      });

      const headerLeft = header.createDiv({ attr: { style: "display:flex;align-items:center;gap:8px;" } });
      const input = headerLeft.createEl("input", { type: "checkbox", attr: { style: "width:20px;height:20px;cursor:pointer;flex-shrink:0;" } });
      input.checked = acceptedTicks.includes(meal.label);
      input.addEventListener("click", (e) => e.stopPropagation());
      input.addEventListener("change", () => {
        if (this._mealActionBusy) return;
        this._mealActionBusy = true;
        input.disabled = true;
        const doAccept = input.checked;
        (async () => {
          try {
            if (doAccept) await this.context.acceptMealPlanAndDeduct(today, meal.label);
            else await this.context.revertMealPlanDeduction(today, meal.label);
          } catch(e) { input.checked = !doAccept; }
          finally { this._mealActionBusy = false; }
          this.context.scheduleRender();
        })();
      });

      const mealColor = mealColors[meal.label] || "var(--nd-accent)";
      headerLeft.createSpan({ text: `${mealIcon[meal.label] || "🍳"} ${meal.label}`, attr: { style: `font-weight:700;font-size:16px;color:${mealColor};` } });
      if (meal.calories > 0) {
        const calBadge = headerLeft.createSpan({ cls: "nd-meal-cal-badge", text: `${meal.calories} kcal`, attr: { style: "color:#fff;font-size:13px;font-weight:600;background:var(--nd-accent);padding:1px 7px;border-radius:4px;" } });
      }

      const headerRight = header.createDiv({ attr: { style: "display:flex;align-items:center;gap:6px;" } });
      const isReplaced = meal.description?.includes("【放纵日自选】");

      headerRight.createSpan({ text: input.checked ? "✅" : "⏳", attr: { style: "font-size:13px;" } });

      // v4.2: [📄] 打开餐次文件按钮
      if (isNewFormat) {
        const openBtn = headerRight.createSpan({
          text: "📄",
          attr: {
            "data-role": "open-meal-btn",
            style: "font-size:12px;cursor:pointer;opacity:0.5;padding:0 2px;transition:opacity 0.2s;",
            title: `打开${meal.label}完整食谱`
          }
        });
        openBtn.addEventListener("mouseenter", () => { openBtn.style.opacity = "1"; });
        openBtn.addEventListener("mouseleave", () => { openBtn.style.opacity = "0.5"; });
        openBtn.addEventListener("click", (ev) => {
          ev.stopPropagation();
          this._openMealFile(meal.label);
        });
      }

      headerRight.createSpan({ text: (this.context.plugin as any)._expandedMeal === meal.label ? "▲" : "▼", attr: { style: "font-size:10px;color:var(--nd-text-soft);" } });

      if (isReplaced) {
        const cancelBtn = headerRight.createSpan({
          text: "↩️",
          attr: { style: "font-size:12px;cursor:pointer;opacity:0.5;padding:0 2px;transition:opacity 0.2s;", title: `取消替换，恢复AI${meal.label}菜谱` }
        });
        cancelBtn.addEventListener("mouseenter", () => { cancelBtn.style.opacity = "1"; });
        cancelBtn.addEventListener("mouseleave", () => { cancelBtn.style.opacity = "0.5"; });
        cancelBtn.addEventListener("click", async (ev) => {
          ev.stopPropagation();
          if (this._mealActionBusy) return;
          this._mealActionBusy = true;
          cancelBtn.setText("⏳");
          try {
            await this.context.cheatDayManager?.removeReplacement(today, meal.label);
            new Notice(`✅ 已恢复AI${meal.label}菜谱`);
          } finally { this._mealActionBusy = false; }
          this.context.scheduleRender();
        });
      }

      const rerollBtn = headerRight.createSpan({
        text: "🔄", attr: { style: "font-size:12px;cursor:pointer;opacity:0.3;padding:0 2px;transition:opacity 0.2s;", title: `仅重做${meal.label}` }
      });
      rerollBtn.addEventListener("mouseenter", () => { rerollBtn.style.opacity = "1"; });
      rerollBtn.addEventListener("mouseleave", () => { rerollBtn.style.opacity = "0.3"; });
      rerollBtn.addEventListener("click", async (ev) => {
        ev.stopPropagation();
        if (this._mealActionBusy) return;
        this._mealActionBusy = true;
        rerollBtn.setText("🎲");
        try {
          await (this.context.plugin as any).reRollSingleMeal?.(today, meal.label);
        } finally { this._mealActionBusy = false; }
        this.context.scheduleRender();
      });

      let mainFood = "该餐主材";
      if (meal.ingredients) {
        const rawFirst = meal.ingredients.split(/[、，,]/)[0] || "";
        mainFood = rawFirst
          .replace(/\([^\)]*\)|\[[^\]]*\]|\（[^）]*\）/g, "")
          .replace(/[\d\.]+(?:g|kg|ml|L|斤|两|枚|个|瓶|袋|适量|少许)?/gi, "")
          .trim() || "该餐主材";
      }
      let blockedRawLine = "";
      if (rulesText) {
        const matchLine = rulesText.split("\n").find(l =>
          l.includes("疲劳屏蔽") && l.includes(`【${mainFood}】`)
        );
        if (matchLine) blockedRawLine = matchLine;
      }
      let _isBlocked = blockedRawLine.length > 0;
      const fatigueBtn = headerRight.createSpan({
        text: _isBlocked ? "🚫" : "🤢",
        attr: { style: `font-size:11px;cursor:pointer;opacity:${_isBlocked ? "0.7" : "0.3"};padding:0 2px;transition:opacity 0.2s;`, title: _isBlocked ? `「${mainFood}」屏蔽中 — 点击解除` : "吃腻了？封杀主料5天" }
      });
      fatigueBtn.addEventListener("mouseenter", () => { fatigueBtn.style.opacity = "1"; });
      fatigueBtn.addEventListener("mouseleave", () => { fatigueBtn.style.opacity = _isBlocked ? "0.7" : "0.3"; });
      fatigueBtn.addEventListener("click", async (ev) => {
        ev.stopPropagation();
        if (_isBlocked) {
          fatigueBtn.setText("⏳");
          try {
            await (this.context.plugin as any).ruleManager?.removeRuleLine?.(blockedRawLine);
            new Notice(`🔓 已解除「${mainFood}」屏蔽，该食材恢复推荐`);
            fatigueBtn.setText("🤢");
            fatigueBtn.style.opacity = "0.3";
            fatigueBtn.setAttr("title", "吃腻了？封杀主料5天");
            _isBlocked = false;
            blockedRawLine = "";
          } catch { fatigueBtn.setText("🚫"); }
        } else {
          fatigueBtn.setText("⏳");
          try {
            await (this.context.plugin as any).ruleManager?.addFatigueRule?.(mainFood, 5);
            new Notice(`🚫 已屏蔽「${mainFood}」，未来5天不再推荐`);
            fatigueBtn.setText("🚫");
            fatigueBtn.style.opacity = "0.7";
            fatigueBtn.setAttr("title", `「${mainFood}」屏蔽中 — 点击解除`);
            _isBlocked = true;
          } catch { fatigueBtn.setText("🤢"); }
        }
      });

      const body = box.createDiv({
        cls: "nd-meal-body",
        attr: { style: "display:block;padding:10px 14px 12px 30px;font-size:15px;line-height:1.7;color:var(--nd-text);border-top:1px solid var(--nd-card-border);" }
      });

      if (isReplaced) {
        const repl = mealReplacements[meal.label as MealSlot];
        let recipe = repl ? (this.context.plugin.recipeLibrary as any)?.getRecipe(repl.recipeId) : null;
        // 用户导入食谱：从 Markdown 文件解析食材
        if (!recipe && repl?.recipeId?.startsWith("user:")) {
          recipe = await this._parseUserRecipe(repl.recipeId);
        }
        if (recipe?.ingredients?.length > 0) {
          // ── 份量缩放按钮 ──
          const servings = repl?.servings || 2;
          const scaleRow = body.createDiv({ attr: { style: "display:flex;align-items:center;gap:8px;margin-bottom:8px;" } });
          scaleRow.createEl("span", { text: "🍽️", attr: { style: "font-size:16px;" } });
          const decBtn = scaleRow.createEl("button", {
            text: "−", attr: { style: "width:24px;height:24px;border:1px solid var(--nd-card-border);border-radius:4px;background:var(--nd-card-bg);color:var(--nd-text);cursor:pointer;font-weight:700;font-size:14px;line-height:1;padding:0;" }
          });
          const servingsLabel = scaleRow.createEl("span", {
            text: `${servings} 人分食`, attr: { style: "font-weight:700;font-size:14px;color:var(--nd-accent);min-width:50px;text-align:center;" }
          });
          const incBtn = scaleRow.createEl("button", {
            text: "+", attr: { style: "width:24px;height:24px;border:1px solid var(--nd-card-border);border-radius:4px;background:var(--nd-card-bg);color:var(--nd-text);cursor:pointer;font-weight:700;font-size:14px;line-height:1;padding:0;" }
          });
          let currentServings = servings;
          const updateServings = async (delta: number) => {
            const newServings = Math.max(1, Math.min(10, currentServings + delta));
            if (newServings === currentServings) return;
            currentServings = newServings;
            repl.servings = newServings;
            await this.context.cheatDayManager?.updateServings(today, meal.label as MealSlot, newServings);
            await this.context.forceRefresh();
          };
          decBtn.addEventListener("click", () => updateServings(-1));
          incBtn.addEventListener("click", () => updateServings(1));

          const ingTitle = body.createEl("div", { attr: { style: "font-weight:600;color:var(--nd-accent);margin-bottom:6px;font-size:14px;" } });
          ingTitle.textContent = "📋 用料（双击数字编辑实际用量）:";
          for (const ing of recipe.ingredients) {
            if (!ing.isCore && ing.amountGrams < 5) continue;
            const actualGrams = repl?.actualQuantities?.[ing.name] ?? ing.amountGrams;
            const row = body.createDiv({ attr: { style: "display:flex;align-items:center;gap:6px;margin-bottom:3px;" } });
            // 备菜勾选框
            const cb = row.createEl("input", { type: "checkbox", attr: { style: "width:16px;height:16px;cursor:pointer;flex-shrink:0;accent-color:var(--nd-accent);" } });
            // 匹配状态指示符
            const match = getFoodDatabase().lookupChinese(ing.name);
            const matchIcon = row.createSpan({ attr: { style: "font-size:12px;flex-shrink:0;cursor:help;" } });
            if (match) {
              const isDirect = match.source === "china";
              matchIcon.setText(isDirect ? "🟢" : "🟡");
              matchIcon.title = `匹配: ${match.name} (${match.source})`;
            } else {
              matchIcon.setText("🔴");
              matchIcon.title = "未匹配到食物数据库";
            }
            const nameSpan = row.createSpan({ text: ing.name, attr: { style: "min-width:70px;font-size:14px;transition:text-decoration 0.15s;" } });
            const qtySpan = row.createSpan({ text: `${Math.round(actualGrams)}g`, attr: { style: "cursor:pointer;color:var(--nd-accent);font-weight:600;font-size:14px;transition:text-decoration 0.15s;" } });
            cb.addEventListener("change", () => {
              const s = cb.checked ? "line-through" : "none";
              nameSpan.style.textDecoration = s;
              qtySpan.style.textDecoration = s;
              nameSpan.style.opacity = cb.checked ? "0.4" : "1";
              qtySpan.style.opacity = cb.checked ? "0.4" : "1";
            });
            qtySpan.addEventListener("dblclick", (ev) => {
              ev.stopPropagation();
              const input = document.createElement("input");
              input.type = "number"; input.value = String(Math.round(actualGrams));
              input.style.cssText = "width:55px;font-size:13px;padding:1px 4px;border:1px solid var(--nd-accent);border-radius:3px;background:var(--nd-card-bg);color:var(--nd-text);";
              qtySpan.replaceWith(input); input.focus(); input.select();
              let isSaving = false;
              const save = async () => {
                if (isSaving) return;
                isSaving = true;
                const v = parseFloat(input.value);
                if (!isNaN(v) && v > 0 && Math.round(v) !== Math.round(actualGrams)) {
                  if (input.parentNode) input.replaceWith(qtySpan);
                  qtySpan.setText(`${Math.round(v)}g ⏳`);
                  await this.context.cheatDayManager?.updateQuantities(today, meal.label as MealSlot, { [ing.name]: v });
                  await this.context.forceRefresh();
                } else {
                  if (input.parentNode) input.replaceWith(qtySpan);
                }
              };
              input.addEventListener("blur", save);
              input.addEventListener("keydown", (ke) => { if (ke.key === "Enter") { ke.preventDefault(); save(); } if (ke.key === "Escape") { if (input.parentNode) input.replaceWith(qtySpan); } });
            });
          }
        }
        if (recipe?.stepsPreview) {
          const stepsDiv = body.createEl("div", { attr: { style: "margin-top:8px;" } });
          const strong = stepsDiv.createEl("strong", { text: "👨‍🍳 做法：" });
          strong.style.color = "var(--nd-accent)";
          stepsDiv.appendChild(document.createTextNode(recipe.stepsPreview));
        }
        // v4.2: "打开完整食谱" 链接（仅替换自选食谱）
        if (repl?.recipeId) {
          const openLinkRow = body.createDiv({ attr: { style: "margin-top:6px;padding-top:6px;border-top:1px solid var(--nd-card-border);" } });
          const openLink = openLinkRow.createEl("button", {
            text: "📄 打开完整食谱",
            attr: {
              "data-role": "open-recipe-btn",
              style: "padding:4px 10px;border:1px solid var(--nd-accent);border-radius:6px;background:var(--nd-card-bg);color:var(--nd-accent);cursor:pointer;font-size:11px;font-weight:600;"
            }
          });
          openLink.addEventListener("click", (ev) => {
            ev.stopPropagation();
            this._openMealFile(meal.label);
          });
        }
        // 单菜谱限定对话按钮
        this._renderRecipeChatButton(body, meal.label, meal.description || recipe?.stepsPreview || "",
          recipe?.ingredients?.map((i: any) => `${i.name} ${i.amountGrams}g`).join(", ") || meal.ingredients || "");
      } else {
        // v4.2: 用料摘要行（data-role 标识）
        if (meal.ingredients) {
          const ingDiv = body.createEl("div", {
            attr: { style: "margin-bottom:6px;", "data-role": "meal-summary" }
          });
          const strong = ingDiv.createEl("strong", { text: "📋 用料：" });
          strong.style.color = "var(--nd-accent)";
          ingDiv.appendChild(document.createTextNode(meal.ingredients));
        }
        // 旧格式：显示完整步骤；新格式：步骤在链接文件中，看板不显示
        if (!isNewFormat && meal.description && meal.description.trim()) {
          const descDiv = body.createEl("div", { attr: { style: "line-height:1.8;" } });
          const strong = descDiv.createEl("strong", { text: "👨‍🍳 做法：" });
          strong.style.color = "var(--nd-accent)";
          descDiv.createEl("br");
          meal.description.split("\n").forEach((line, idx) => {
            if (idx > 0) descDiv.createEl("br");
            descDiv.appendChild(document.createTextNode(line));
          });
        }
        // 新格式：提示点击打开查看完整食谱
        if (isNewFormat && meal.ingredients) {
          const hintEl = body.createEl("div", {
            attr: {
              style: "font-size:11px;color:var(--nd-text-soft);margin-top:2px;cursor:pointer;",
              "data-role": "meal-file-hint"
            }
          });
          hintEl.textContent = "💡 点击 📄 查看完整食谱与步骤";
          hintEl.addEventListener("click", (ev) => { ev.stopPropagation(); this._openMealFile(meal.label); });
        }
        // 单菜谱限定对话按钮
        this._renderRecipeChatButton(body, meal.label, meal.description || "", meal.ingredients || "");
      }
    }

  }

  /** v4.2 打开餐次对应文件（替换餐次→打开替换食谱，AI餐次→打开AI餐文件） */
  private _openMealFile(label: string): void {
    const info = this._mealRuntimeInfos?.find((m: MealRuntimeInfo) => m.label === label);
    if (!info) return;

    // 替换餐次：优先打开离线网页存档，回退到 .md 文件
    if (info.isReplaced) {
      const today = this._displayDate || this.context.todayKey();
      const repl = this.context.settings.mealReplacements?.[today]?.[label];
      if (repl?.recipeId) {
        const recipePath = repl.recipeId.startsWith("user:")
          ? repl.recipeId.replace("user:", "")
          : repl.recipeId;

        // Track B 优先: 查离线网页存档
        if (repl.recipeId.startsWith("user:")) {
          const cleanName = recipePath
            .replace(/^.*\/食谱-/, "")    // "红烧排骨.md"
            .replace(/\.md$/, "");         // "红烧排骨"
          const archivePath = `Diet/Recipe_Assets/${cleanName}/index.html`;
          const archiveFile = this.context.app.vault.getAbstractFileByPath(archivePath);
          if (archiveFile instanceof TFile) {
            const plugin = this.context.plugin as any;
            if (typeof plugin?._openHtmlInReader === "function") {
              plugin._openHtmlInReader(archiveFile);
              return;
            }
          }
        }

        // 回退: 打开 .md 文件
        if (recipePath) {
          this.context.openPath(recipePath);
          return;
        }
      }
    }

    // 默认：打开 AI 生成的餐次文件
    if (info.filePath) {
      this.context.openPath(info.filePath);
    }
  }

  /** 解析用户导入的食谱 Markdown → ParsedRecipe */
  private async _parseUserRecipe(recipeId: string): Promise<any | null> {
    const filePath = recipeId.replace("user:", "");
    const file = this.context.app.vault.getAbstractFileByPath(filePath);
    if (!(file instanceof TFile)) return null;
    try {
      const content = await this.context.app.vault.read(file);
      let calTotal = 0;
      const calMatch = content.match(/calories_total:\s*(\d+)/);
      if (calMatch) calTotal = parseInt(calMatch[1]!, 10);
      const ingredients: any[] = [];
      const tableSection = content.match(/##\s*🥩\s*食材清单[\s\S]*?(?=\n##\s|$)/);
      if (tableSection) {
        const rows = tableSection[0].split("\n").filter(l => l.includes("|") && l.includes("**"));
        for (const row of rows) {
          const cells = row.split("|").map(c => c.trim()).filter(Boolean);
          if (cells.length >= 2) {
            const ingName = cells[0]!.replace(/\*\*/g, "");
            const gramMatch = cells[1]!.match(/(\d+)\s*g/);
            const grams = gramMatch ? parseInt(gramMatch[1]!, 10) : 0;
            if (ingName && grams > 0) ingredients.push({ name: ingName, amountGrams: grams, isCore: grams >= 20 });
          }
        }
      }
      // 如果 frontmatter 热量为 0，用 FoodDatabase 实时计算兜底
      if (calTotal === 0 && ingredients.length > 0) {
        const db = getFoodDatabase();
        for (const ing of ingredients) {
          const match = db.lookupChinese(ing.name);
          if (match?.nutrients?.Energy) calTotal += Math.round((ing.amountGrams / 100) * match.nutrients.Energy);
        }
      }
      // 解析步骤
      let stepsPreview = "";
      const stepsSection = content.match(/##\s*🍳\s*烹饪步骤[\s\S]*?(?=\n##\s|$)/);
      if (stepsSection) {
        stepsPreview = stepsSection[0].split("\n").filter(l => /^\d+\./.test(l.trim())).join("\n");
      }
      return { name: file.basename.replace(/^食谱-/, ""), ingredients, caloriesPerServe: calTotal, stepsPreview };
    } catch { return null; }
  }

  /** 单菜谱限定上下文对话面板（移植自 Smart Recipe Gen） */
  private _renderRecipeChatButton(container: HTMLElement, mealLabel: string, steps: string, ingredients: string): void {
    const chatRow = container.createDiv({ attr: { style: "margin-top:8px;padding-top:8px;border-top:1px solid var(--nd-card-border);" } });
    const toggleBtn = chatRow.createEl("button", {
      text: `💬 问「${mealLabel}」`,
      attr: { style: "padding:4px 10px;border:1px solid var(--nd-card-border);border-radius:6px;background:var(--nd-card-bg);color:var(--nd-text-soft);cursor:pointer;font-size:11px;font-weight:600;" }
    });
    const chatPanel = chatRow.createDiv({ attr: { style: "display:none;margin-top:6px;" } });
    const chatLog = chatPanel.createDiv({ attr: { style: "max-height:150px;overflow-y:auto;font-size:12px;margin-bottom:6px;" } });
    const inputRow = chatPanel.createDiv({ attr: { style: "display:flex;gap:4px;" } });
    const qInput = inputRow.createEl("input", {
      type: "text", placeholder: "如：能换成鸡胸肉吗？",
      attr: { style: "flex:1;padding:4px 8px;border:1px solid var(--nd-card-border);border-radius:4px;font-size:12px;background:var(--nd-card-bg);color:var(--nd-text);" }
    });
    const sendBtn = inputRow.createEl("button", {
      text: "发送", attr: { style: "padding:4px 10px;border:1px solid var(--nd-accent);border-radius:4px;background:var(--nd-accent);color:#fff;cursor:pointer;font-size:11px;font-weight:600;" }
    });
    let panelOpen = false;
    toggleBtn.addEventListener("click", () => { panelOpen = !panelOpen; chatPanel.style.display = panelOpen ? "block" : "none"; });
    const send = async () => {
      const q = qInput.value.trim();
      if (!q) return;
      qInput.value = ""; sendBtn.disabled = true; sendBtn.setText("...");
      chatLog.createDiv({ text: `🧑 ${q}`, attr: { style: "margin-bottom:4px;color:var(--nd-accent);" } });
      try {
        const agy = (this.context.plugin as any).getAgyEngine?.();
        const reply = await agy?.conductRecipeChat(mealLabel, ingredients, steps, q);
        if (reply) chatLog.createDiv({ text: `🤖 ${reply}`, attr: { style: "margin-bottom:4px;color:var(--nd-text);" } });
        else chatLog.createDiv({ text: "🤖 抱歉，暂时无法回答。", attr: { style: "color:var(--nd-text-soft);" } });
      } catch { chatLog.createDiv({ text: "🤖 网络异常，请稍后重试。", attr: { style: "color:var(--nd-text-soft);" } }); }
      sendBtn.disabled = false; sendBtn.setText("发送");
      chatLog.scrollTop = chatLog.scrollHeight;
    };
    sendBtn.addEventListener("click", send);
    qInput.addEventListener("keydown", (e: KeyboardEvent) => { if (e.key === "Enter") send(); });
  }
}

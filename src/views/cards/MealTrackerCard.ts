import { BaseCard } from "./BaseCard";
import { RecipePickerModal } from "../RecipePickerModal";

export class MealTrackerCard extends BaseCard {
  private mealTrackerDate: Date = new Date();

  private calorieRatioToColor(ratio: number): string {
    const r = Math.max(0, ratio);
    if (r <= 0) return "transparent";
    let h: number, s: number, l: number;
    if (r <= 0.5) {
      const t = r / 0.5;
      h = 142 - t * 94;
      s = 76 + t * 20;
      l = 55 - t * 2;
    } else if (r <= 0.8) {
      const t = (r - 0.5) / 0.3;
      h = 48 - t * 16;
      s = 96;
      l = 53;
    } else if (r <= 1.0) {
      const t = (r - 0.8) / 0.2;
      h = 32 - t * 32;
      s = 95 - t * 11;
      l = 53 - t * 3;
    } else if (r <= 1.5) {
      const t = (r - 1.0) / 0.5;
      h = 0;
      s = 84 - t * 14;
      l = 50 - t * 20;
    } else {
      h = 0; s = 70; l = 20;
    }
    return `hsl(${Math.round(h)}, ${Math.round(s)}%, ${Math.round(l)}%)`;
  }

  render(): void {
    const card = this.createCard("focus", "🥗 饮食打卡", "");
    const year = this.mealTrackerDate.getFullYear();
    const month = this.mealTrackerDate.getMonth();

    const nav = card.createDiv({ attr: { style: "display:flex;align-items:center;justify-content:space-between;margin-bottom:4px;" } });
    nav.createEl("button", { text: "‹", attr: { style: "border:none;background:none;font-size:15px;cursor:pointer;color:var(--nd-accent);padding:0 4px;" } })
      .addEventListener("click", () => { this.mealTrackerDate = new Date(year, month - 1, 1); this.context.scheduleRender(); });
    nav.createEl("span", { text: `${year}年${month + 1}月`, attr: { style: "font-weight:600;font-size:13px;color:var(--nd-text);" } });
    nav.createEl("button", { text: "›", attr: { style: "border:none;background:none;font-size:15px;cursor:pointer;color:var(--nd-accent);padding:0 4px;" } })
      .addEventListener("click", () => { this.mealTrackerDate = new Date(year, month + 1, 1); this.context.scheduleRender(); });

    const weekHeader = card.createDiv({ attr: { style: "display:grid;grid-template-columns:repeat(7,1fr);gap:1px;margin-bottom:1px;" } });
    ["一","二","三","四","五","六","日"].forEach(w => {
      weekHeader.createEl("span", { text: w, attr: { style: "text-align:center;font-size:8px;color:var(--nd-text-soft);" } });
    });

    const acceptedTicks = this.context.settings.acceptedMealTicks || {};
    const daysInMonth = new Date(year, month + 1, 0).getDate();
    const firstDayOfWeek = new Date(year, month, 1).getDay();
    const startPad = firstDayOfWeek === 0 ? 6 : firstDayOfWeek - 1;
    const today = this.context.todayKey();

    const mealReplacements = this.context.settings.mealReplacements || {};

    const gridEl = card.createDiv({ attr: { style: "display:grid;grid-template-columns:repeat(7,1fr);gap:1px;" } });
    for (let i = 0; i < startPad; i++) gridEl.createDiv();

    for (let day = 1; day <= daysInMonth; day++) {
      const dateKey = `${year}-${String(month + 1).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
      const isToday = dateKey === today;

      let bgColor = "transparent";
      let fgColor = "var(--nd-text-soft)";
      let tooltip = dateKey;

      const safeTarget = Math.max(1, this.context.cachedTargetCal || 2000);
      const replDay = mealReplacements[dateKey];
      const replCal = replDay ? (Object.values(replDay) as any[]).filter(Boolean).reduce((s: number, m: any) => s + (m.adjustedCalories ?? m.baseCalories ?? 0), 0) : 0;
      const aiMealCount = Math.min(3, (acceptedTicks[dateKey] || []).length);
      const estAiCal = aiMealCount * Math.round(safeTarget / 3);
      const totalCal = replCal + estAiCal;

      if (totalCal <= 0) {
        bgColor = "transparent";
        fgColor = "var(--nd-text-soft)";
      } else {
        const ratio = Math.min(2, totalCal / safeTarget);
        bgColor = this.calorieRatioToColor(ratio);
        fgColor = ratio > 0.5 ? "#fff" : "var(--nd-text-soft)";
        const parts: string[] = [];
        if (replCal > 0) parts.push(`自选 ${replCal}kcal`);
        if (aiMealCount > 0) parts.push(`AI ${aiMealCount}餐(${estAiCal}kcal)`);
        tooltip = `${dateKey}: ${parts.join(" + ")} = ${totalCal}kcal (${Math.round(ratio * 100)}%)`;
      }

      const cell = gridEl.createDiv({
        attr: {
          style: [
            "height:16px", "display:flex", "align-items:center", "justify-content:center",
            `background:${bgColor}`, "border-radius:2px",
            "font-size:8px", `color:${fgColor}`,
            isToday ? "outline:1.5px solid var(--nd-accent);outline-offset:-1px;" : "",
          ].join(";")
        }
      });
      cell.setText(`${day}`);
      cell.title = tooltip;
    }

    const bottomRow = card.createDiv({ attr: { style: "display:flex;justify-content:flex-end;align-items:center;margin-top:4px;padding-top:4px;border-top:1px solid var(--nd-card-border);" } });
    const hasReplacements = this.context.cheatDayManager?.hasReplacements(today);
    const cheatBtn = bottomRow.createEl("button", {
      text: hasReplacements ? "🔥 已替换" : "🎉 今日放纵",
      attr: { style: `font-size:10px;padding:2px 8px;border-radius:10px;border:1px solid var(--nd-accent);background:${hasReplacements ? "var(--nd-accent)" : "var(--nd-card-bg)"};color:${hasReplacements ? "#fff" : "var(--nd-accent)"};cursor:pointer;font-weight:600;` }
    });
    cheatBtn.addEventListener("click", async () => {
      new RecipePickerModal(this.context.app, this.context.plugin as any, today).open();
    });
  }
}

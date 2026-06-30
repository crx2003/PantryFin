// src/services/RecipeLibrary.ts
//
// 内嵌菜谱库：从打包的 recipes.json 加载 154 道 HowToCook 菜谱，
// 提供分类浏览、关键词搜索、单条查询 API。

import recipesEmbedded from "../nutrition/recipes.json";
import type { ParsedRecipe } from "../models/types";

export interface CategoryInfo {
  id: string;
  label: string;
  count: number;
}

export class RecipeLibrary {
  private recipes: Map<string, ParsedRecipe> = new Map();
  private categories: CategoryInfo[] = [];
  private initialized = false;

  constructor() {
    this._init();
  }

  private _init(): void {
    if (this.initialized) return;
    const raw = recipesEmbedded as unknown as ParsedRecipe[];
    for (const r of raw) {
      this.recipes.set(r.id, r);
    }

    // 构建分类列表
    const catMap = new Map<string, number>();
    for (const r of raw) {
      catMap.set(r.category, (catMap.get(r.category) || 0) + 1);
    }
    this.categories = Array.from(catMap.entries())
      .map(([id, count]) => ({
        id,
        label: raw.find(r => r.category === id)?.categoryLabel || id,
        count,
      }))
      .sort((a, b) => b.count - a.count);

    this.initialized = true;
  }

  isReady(): boolean { return this.initialized; }

  getCategories(): CategoryInfo[] {
    return [...this.categories];
  }

  getRecipesByCategory(category: string): ParsedRecipe[] {
    if (category === "all") return Array.from(this.recipes.values());
    return Array.from(this.recipes.values()).filter(r => r.category === category);
  }

  getRecipe(id: string): ParsedRecipe | undefined {
    return this.recipes.get(id);
  }

  searchRecipes(query: string): ParsedRecipe[] {
    const q = query.toLowerCase();
    return Array.from(this.recipes.values()).filter(r =>
      r.name.toLowerCase().includes(q) ||
      r.categoryLabel.includes(q) ||
      r.ingredients.some(i => i.name.includes(q))
    );
  }

  getAllRecipes(): ParsedRecipe[] {
    return Array.from(this.recipes.values());
  }

  getTotalCount(): number {
    return this.recipes.size;
  }
}

// src/services/IngredientValidator.ts
//
// AI 食材校验器 v1.0
// 移植自 Smart Recipe Generator: getIngredientValidationPrompt()
// 判断用户输入的食材名是否为真实食材，返回建议的标准名

import type { AgyEngine } from "./AgyEngine";

export interface ValidationResult {
  isValid: boolean;
  variations: string[];
  rawResponse: string;
}

export class IngredientValidator {
  constructor(private agyEngine: AgyEngine) {}

  async validate(ingredientName: string): Promise<ValidationResult> {
    const prompt = `Act as a Food Ingredient Validation Assistant. Given the ingredient name: "${ingredientName}", your task is to evaluate the ingredient and return a JSON object with exactly two keys:

{ "isValid": true/false, "possibleVariations": ["variation1", "variation2", "variation3"] }

Rules:
- The isValid field must be true ONLY if the ingredient name is correctly spelled and commonly used in recipes. For Chinese ingredient names (e.g., "三层肉", "蕃茄", "土豆"), apply the same logic: check if it's a real Chinese food name.
- The isValid field must be false if the input is not a real ingredient, is too vague (e.g., "好吃的"), or is a misspelling.
- The possibleVariations field must contain an array of 2 to 3 valid variations, alternative names, or related ingredients. For Chinese ingredients, return Chinese standard names (e.g., for "三层肉" → ["五花肉", "pork belly"]).
- If the ingredient is invalid due to misspelling, include the corrected name(s) in possibleVariations.
- If there are no recognized variations, return an empty array.
- The output must be strictly valid JSON without any additional text, markdown, or code blocks.

Examples:
Input: "cuscus"
Expected Output: { "isValid": false, "possibleVariations": ["couscous"] }

Input: "三层肉"
Expected Output: { "isValid": false, "possibleVariations": ["五花肉", "pork belly"] }

Input: "蕃茄"
Expected Output: { "isValid": false, "possibleVariations": ["番茄", "西红柿"] }`;

    try {
      const rawOutput = await this.agyEngine.executeRaw(prompt);
      if (!rawOutput) {
        return { isValid: false, variations: [], rawResponse: "" };
      }

      // 尝试直接解析 JSON
      const cleaned = rawOutput
        .replace(/[][[()#;?]*(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-9A-ORZcf-nqry=><]/g, "")
        .trim();
      const jsonMatch = cleaned.match(/\{[\s\S]*"isValid"[\s\S]*\}/);
      if (jsonMatch) {
        const parsed = JSON.parse(jsonMatch[0]);
        return {
          isValid: parsed.isValid === true,
          variations: Array.isArray(parsed.possibleVariations) ? parsed.possibleVariations : [],
          rawResponse: cleaned,
        };
      }
      // 回退：尝试直接 parse 整个响应
      const parsed = JSON.parse(cleaned);
      return {
        isValid: parsed.isValid === true,
        variations: Array.isArray(parsed.possibleVariations) ? parsed.possibleVariations : [],
        rawResponse: cleaned,
      };
    } catch {
      return { isValid: false, variations: [], rawResponse: "" };
    }
  }
}

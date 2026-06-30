import miniIndex from "../../fdc-mini-index.json";

export type FDCFoodEntry = [string, Record<string, number>];

let cachedData: FDCFoodEntry[] | null = null;

export function getFDCFoods(): FDCFoodEntry[] {
    if (cachedData) return cachedData;
    return (miniIndex as unknown) as FDCFoodEntry[];
}

export function setFDCFoods(data: FDCFoodEntry[]): void {
    cachedData = data;
}

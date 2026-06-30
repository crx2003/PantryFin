// src/utils/Error.ts
//
// Templater 风格统一错误处理: PantryFinError + errorWrapper。
// 消除散落的 try-catch 和空 catch {} 块。

export class PantryFinError extends Error {
    constructor(
        msg: string,
        public console_msg?: string
    ) {
        super(msg);
        this.name = "PantryFinError";
    }
}

/** 异步操作包装：自动捕获 → 日志 → 返回 null（不抛异常） */
export async function errorWrapper<T>(
    fn: () => Promise<T>,
    context: string
): Promise<T | null> {
    try {
        return await fn();
    } catch (e) {
        const err = e instanceof PantryFinError
            ? e
            : new PantryFinError(
                `[${context}] ${e instanceof Error ? e.message : String(e)}`,
                e instanceof Error ? e.stack : undefined
            );
        console.error(`[PantryFin] ${err.message}`, err.console_msg || "");
        return null;
    }
}

/** 同步操作包装 */
export function errorWrapperSync<T>(fn: () => T, context: string): T | null {
    try {
        return fn();
    } catch (e) {
        console.error(
            `[PantryFin] [${context}] ${e instanceof Error ? e.message : String(e)}`
        );
        return null;
    }
}
